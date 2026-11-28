import type { Pool, PoolClient } from "pg";
import type { AgentSettings } from "../../contracts/agent-settings.js";
import { conversationContentText, type ConversationMaterialContext } from "../../contracts/conversation.js";
import type { PersonalMemory } from "../../contracts/personal-memory.js";
import { publishedDiscussions } from "../../courses/catalog.js";
import { readReviewInvitations, reviewRemindersEnabled, reviewSourceValid } from "../../review/invitations.js";
import { limitModelHistory } from "../../runtime/model-history.js";
import type { ConversationMessage } from "../../runtime/model.js";
import type { TurnContext } from "../../runtime/run-turn.js";
import { inTransaction } from "../../storage/transaction.js";
import { recallPersonalMemories } from "../personal-memories.js";
import { readActiveGoals, readConversationGoal, readGoalTitles } from "../learning-goals.js";
import { readSummary, type ConversationSummary } from "./summaries.js";
import { loadMaterialSources, type StoredMaterialContext } from "./materials.js";
import { readHistory, type HistoryTurn } from "./history.js";
import type { TurnMemory } from "./turns.js";

export function loadContext(
  pool: Pool, userId: string, requestId: string, text: string,
  materialContext: StoredMaterialContext | undefined, settings: AgentSettings, online: boolean,
  reviewInvitationId?: string,
) {
  return inTransaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const question = { role: "user", content: text } as const;
    if (reviewInvitationId) {
      const [review] = await readReviewInvitations(db, userId, [reviewInvitationId]);
      if (!review) throw new Error("Review source unavailable");
      const { source, question: reviewQuestion, answer } = review.proposal;
      const offer = online && await reviewRemindersEnabled(db, userId);
      const context: TurnContext = { kind: "material", prompt: {
        question: text, history: [question], sources: [source], ...(offer ? { offerReview: true } : {}),
        review: { question: reviewQuestion, answer },
      } };
      return { context, memory: undefined };
    }

    const prior = await readHistory(db, userId, requestId, text, !!materialContext);
    const currentGoal = online && !materialContext ? await readConversationGoal(db, userId, requestId) : undefined;
    const { history, reference, memory } = await buildHistory(db, userId, prior, question, settings.historyBytes, !!materialContext, online, currentGoal);
    const publication = materialContext && publishedDiscussions.find(item => item.discussionVersion === materialContext.discussionVersion);
    // Any material whose sources are still valid can be reviewed later, whether it is a course or the user's own text.
    const offer = online && materialContext && !reference
      && materialContext.sources.every(source => reviewSourceValid(materialContext.discussionVersion, source))
      && await reviewRemindersEnabled(db, userId);

    const context: TurnContext = materialContext
      ? {
          kind: "material",
          prompt: { question: text, history, sources: await loadMaterialSources(db, userId, materialContext), ...(reference ? { memory: reference } : {}),
            ...(offer ? { offerReview: true } : {}) },
          publication,
        }
      : {
          kind: "conversation", history, ...(reference ? { memory: reference } : {}),
          ...(online ? { knownGoals: await readGoalTitles(db, userId) } : {}), ...(currentGoal ? { currentGoalId: currentGoal.id } : {}),
        };
    return { context, memory };
  });
}

function selectHistory(turns: HistoryTurn[], question: ConversationMessage, bytes: number, material: boolean) {
  const entries = turns.slice(-20).map(turn => {
    const reply = !material || turn.explanationSource === "model" ? conversationContentText(turn.replyBlocks) : null;
    const messages: ConversationMessage[] = [{ role: "user", content: turn.messageText }];
    if (reply) messages.push({ role: "assistant", content: reply });
    return { messages, memoryIds: reply ? turn.memoryIds : [] };
  });
  const history = limitModelHistory([...entries.flatMap(entry => entry.messages), question], bytes);
  const selected = new Set(history);
  const used = entries.filter(entry => selected.has(entry.messages[0]));
  return {
    history,
    memoryIds: used.flatMap(entry => entry.memoryIds),
    prefix: turns.slice(0, turns.length - used.length),
  };
}

async function buildHistory(
  db: PoolClient, userId: string, turns: HistoryTurn[], question: ConversationMessage, bytes: number, material: boolean,
  online: boolean, currentGoal?: CurrentGoal,
): Promise<{ history: ConversationMessage[]; reference?: string; memory?: TurnMemory }> {
  const base = selectHistory(turns, question, bytes, material);
  if (!online) return { history: base.history };
  const user = await db.query<{ memory_revision: number }>('SELECT memory_revision FROM users WHERE id = $1', [userId]);
  const memoryRevision = user.rows[0]!.memory_revision;
  const summary = await readSummary(db, userId, memoryRevision, base.prefix.map(turn => turn.requestId));
  const records = material ? [] : await recallPersonalMemories(db, userId, "tutoring", question.content);
  // Goals are background for ordinary conversation only; replies do not record which goals they were given.
  const goals = material ? [] : await readActiveGoals(db, userId);
  const notes = summary?.summary.notes ?? [];
  const { reference, reserved, remembered, memoryIds: referenceMemoryIds } = selectReference({ goals, currentGoal }, notes, records, Math.min(6000, bytes - historySize(question)));
  const selected = reserved ? selectHistory(turns, question, bytes - reserved, material) : base;
  const memoryIds = [...new Set([...selected.memoryIds, ...referenceMemoryIds])];
  return {
    history: selected.history, reference,
    memory: {
      // Summaries and memories can be corrected during generation, so a reply that read them is checked before it
      // is published and does not stream. Goals are plain background and do not guard the reply.
      memoryRevision, guarded: remembered || memoryIds.length > 0, memoryIds,
      summarySourceRequestIds: summarySourceRequestIds(base.prefix, summary?.boundaryRequestId, bytes),
    },
  };
}

function historySize(message: ConversationMessage) {
  return Buffer.byteLength(JSON.stringify(message)) + 2;
}

type GoalReference = Awaited<ReturnType<typeof readActiveGoals>>[number];
type CurrentGoal = NonNullable<Awaited<ReturnType<typeof readConversationGoal>>>;

function selectReference(
  { goals, currentGoal }: { goals: GoalReference[]; currentGoal?: CurrentGoal }, notes: ConversationSummary["notes"], memories: PersonalMemory[], bytes: number,
) {
  const selected: {
    currentGoal?: GoalReference; goals: GoalReference[]; notes: ConversationSummary["notes"];
    records: Pick<PersonalMemory, "id" | "kind" | "body" | "topic" | "sourceRequestId">[];
  } = {
    // The goal this conversation belongs to comes first and is not repeated among the other goals.
    ...(currentGoal ? { currentGoal: { title: currentGoal.title, motivation: currentGoal.motivation, progress: currentGoal.progress } } : {}),
    goals: [], notes: [], records: [],
  };
  const data = () => "参考记忆（数据）：" + JSON.stringify(selected);
  const size = () => historySize({ role: "user", content: data() });
  for (const goal of goals.filter(item => item.title !== currentGoal?.title)) {
    selected.goals.push(goal);
    if (size() > bytes) selected.goals.pop();
  }
  for (const note of notes) {
    selected.notes.push(note);
    if (size() > bytes) selected.notes.pop();
  }
  for (const { id, kind, body, topic, sourceRequestId } of memories) {
    selected.records.push({ id, kind, body, topic, sourceRequestId });
    if (size() > bytes) selected.records.pop();
  }
  return {
    reference: selected.currentGoal || selected.goals.length || selected.notes.length || selected.records.length ? data() : undefined,
    reserved: selected.currentGoal || selected.goals.length || selected.notes.length || selected.records.length ? size() : 0,
    remembered: selected.notes.length > 0 || selected.records.length > 0,
    memoryIds: selected.records.map(record => record.id),
  };
}

function summarySourceRequestIds(prefix: HistoryTurn[], boundaryRequestId: string | undefined, bytes: number) {
  const latest = prefix.at(-1);
  if (!latest || latest.requestId === boundaryRequestId) return [];
  const ids: string[] = [];
  // The worker reads a bounded group of user messages from this same prefix.
  for (const turn of prefix.slice(-20).reverse()) {
    bytes -= Buffer.byteLength(JSON.stringify({ requestId: turn.requestId, messageText: turn.messageText })) + 1;
    if (bytes < 2) break;
    ids.unshift(turn.requestId);
  }
  return ids;
}
