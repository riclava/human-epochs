import type { Pool, PoolClient } from "pg";
import type { ActivityChatTurn } from "../../contracts/chat.js";
import type { ActivityView } from "../../contracts/learning.js";
import { inTransaction } from "../../storage/transaction.js";
import { getActivity, lockActivity, requestHintInTransaction } from "../../activities/activities.js";
import { readDiscussionOrigin } from "./practice.js";

type ActivityMessage = Omit<ActivityChatTurn, "reply" | "status">;
type Target = { learnerId: string; activityId: string };
type TurnResult = { turn: ActivityChatTurn; activity: ActivityView };
type Outcome = TurnResult | { message: string; activity: ActivityView } | null;
const turnJson = `jsonb_build_object(
  'requestId', request_id, 'revision', request_revision,
  'text', message_text, 'intent', intent, 'reply', reply_text, 'status', status
) AS turn`;
type TurnRow = { turn: ActivityChatTurn };

function asksForHint(text: string): boolean {
  // Only a standalone request grants help. Strip conversational framing before matching the action.
  const request = text.replace(/\s/gu, "").replace(/[。.!！?？]+$/u, "")
    .replace(/^请问[，,]?/u, "").replace(/^(?:可以|能不能|能否|能|麻烦|请|我想|我需要)/u, "")
    .replace(/(?:一下|好吗|吧|吗|么)$/u, "");
  return /^(?:(?:给我|发我|给|来|要|领取|领)(?:一条|一个|一点|条|点|个)?)?(?:提示|线索)$/u.test(request);
}

const recallQuestion = /我(?:刚才|刚刚|之前|上次|上一条消息)(?:说了什么|说过什么|说的是什么|写了什么|问了什么|是什么)/u;

function replyToMessage(text: string, activity: ActivityView): string {
  if (/回看.*(?:提示|线索)|(?:领过|已领|之前的|刚才的)(?:的)?(?:提示|线索)/u.test(text)) {
    return activity.hints.length ? activity.hints.join("\n") : "这项活动还没有领取提示。需要时可以发送“给我一条提示”。";
  }
  if (/目标|练什么|练习什么|考什么/u.test(text)) return activity.goal;
  if (/题面|题目要求|要我做什么|需要做什么|这道题要做什么/u.test(text)) return activity.prompt;
  if (/什么是|是什么|意思|区别|怎么理解|怎么定义|如何理解|怎么摘录/u.test(text)) {
    const clarification = activity.clarifications.find(item => item.terms.some(term => text.includes(term)));
    if (clarification) return clarification.text;
  }
  return "可以问我活动目标，也可以发送“给我一条提示”后结合线索继续讨论。";
}

async function findTurn(db: PoolClient, target: Target, requestId: string) {
  return (await db.query<TurnRow>(
    'SELECT ' + turnJson + ' FROM activity_chat_turns WHERE learner_id = $1 AND activity_id = $2 AND request_id = $3',
    [target.learnerId, target.activityId, requestId],
  )).rows[0]?.turn;
}

async function receive(db: PoolClient, target: Target, command: ActivityMessage): Promise<Outcome> {
  const { learnerId, activityId } = target;
  const activity = await lockActivity(db, learnerId, activityId);
  if (!activity) return null;
  const { requestId, revision, text, intent } = command;
  const prior = await findTurn(db, target, requestId);
  if (prior) {
    if (prior.revision !== revision || prior.text !== text || prior.intent !== intent) {
      return { message: "这条消息已保存，修改后请作为新消息发送。", activity };
    }
    return { turn: prior, activity };
  }
  const open = await db.query(`SELECT 1 FROM activity_chat_turns
    WHERE activity_id = $1 AND status = 'pending'`, [activityId]);
  if (open.rowCount) return { message: "上一条消息正在等待回复。请刷新对话并重试上一条消息。", activity };
  const saved = await db.query<TurnRow>(
    `INSERT INTO activity_chat_turns (learner_id, activity_id, request_id, request_revision, message_text, intent)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ` + turnJson,
    [learnerId, activityId, requestId, revision, text, intent],
  );
  return { turn: saved.rows[0]!.turn, activity };
}

async function finish(db: PoolClient, target: Target, requestId: string): Promise<Outcome> {
  const { learnerId, activityId } = target;
  let activity = await lockActivity(db, learnerId, activityId);
  if (!activity) return null;
  const turn = await findTurn(db, target, requestId);
  if (!turn) return null;
  if (turn.status !== "pending") return { turn, activity };

  let status: ActivityChatTurn["status"] = "complete";
  let response: string;
  if (turn.intent === "hint") {
    const hint = await requestHintInTransaction(db, learnerId, {
      activityId, revision: turn.revision, commandId: requestId,
    });
    if (hint.kind === "not_found") return null;
    if (hint.kind === "received") {
      activity = hint.result.activity;
      response = hint.result.hint;
    } else {
      status = "conflict";
      response = hint.message;
      activity = hint.activity;
    }
  } else if (recallQuestion.test(turn.text)) {
    const previous = (await db.query<{ text: string }>(
      'SELECT message_text AS text FROM activity_chat_turns '
        + 'WHERE learner_id = $1 AND activity_id = $2 '
        + 'AND position < (SELECT position FROM activity_chat_turns WHERE activity_id = $2 AND request_id = $3) '
        + 'ORDER BY position DESC LIMIT 1',
      [learnerId, activityId, requestId],
    )).rows[0];
    response = previous ? '你在这项活动的上一条消息里写道：“' + previous.text + '”' : "这是你在这项活动的第一条消息。";
  } else {
    response = replyToMessage(turn.text, activity);
  }
  const published = await db.query<TurnRow>(
    'UPDATE activity_chat_turns SET status = $4, reply_text = $5 '
      + 'WHERE learner_id = $1 AND activity_id = $2 AND request_id = $3 RETURNING ' + turnJson,
    [learnerId, activityId, requestId, status, response],
  );
  return { activity, turn: published.rows[0]!.turn };
}

export function readActivityDiscussion(pool: Pool, { learnerId, activityId }: Target) {
  return inTransaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const activity = await getActivity(db, learnerId, activityId);
    if (!activity) return null;
    const turns = await db.query<TurnRow>(
      'SELECT ' + turnJson + ' FROM activity_chat_turns WHERE learner_id = $1 AND activity_id = $2 ORDER BY position',
      [learnerId, activityId],
    );
    const origin = await readDiscussionOrigin(db, learnerId, activityId);
    return { turns: turns.rows.map(row => row.turn), activity, ...(origin ? { origin } : {}) };
  });
}

export type ActivityMessageInput = Omit<ActivityMessage, "intent"> & { intent?: ActivityMessage["intent"] };

export async function sendActivityMessage(pool: Pool, target: Target, input: ActivityMessageInput) {
  const command: ActivityMessage = {
    ...input,
    intent: input.intent === "hint" || asksForHint(input.text) ? "hint" : "message",
  };
  // The learner's message survives a process exit before its reply or its hint is published.
  let outcome = await inTransaction(pool, db => receive(db, target, command));
  if (outcome && "turn" in outcome && outcome.turn.status === "pending") {
    outcome = await inTransaction(pool, db => finish(db, target, command.requestId));
  }
  return outcome;
}
