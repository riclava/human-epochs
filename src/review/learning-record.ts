import type { Pool, PoolClient } from "pg";
import type { ConversationSource } from "../contracts/conversation.js";
import type { LearningCommand, LearningRecord, LearningTopic, ReviewResult } from "../contracts/learning.js";
import { reviewSourceAvailable } from "./invitations.js";
import type { ReviewOutcome, ReviewProposal } from "./proposal.js";

// Stored in the same transaction as the feedback it judges, so a published answer always has its result.
export async function recordReviewAttempt(
  db: PoolClient, userId: string, requestId: string, reviewInvitationId: string, outcome: ReviewOutcome, now: Date,
) {
  await db.query(`
    INSERT INTO review_attempts (user_id, request_id, review_invitation_id, outcome, note, answered_at)
    VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING
  `, [userId, requestId, reviewInvitationId, outcome.result, outcome.note, now]);
}


interface InvitationRow {
  id: string;
  originRequestId: string;
  proposal: ReviewProposal;
  dueAt: Date;
  questionRequestId: string | null;
  cancelled: boolean;
  discussionVersion: string | null;
  sources: ConversationSource[];
  conversationId: string;
  conversationTitle: string | null;
}

export async function readLearningRecord(db: Pool | PoolClient, userId: string): Promise<LearningRecord> {
  const { rows: invitations } = await db.query<InvitationRow>(`
    SELECT r.id, r.origin_request_id AS "originRequestId", r.proposal, r.due_at AS "dueAt",
      r.question_request_id AS "questionRequestId", r.cancelled,
      origin.material_context->>'discussionVersion' AS "discussionVersion", origin.material_context->'sources' AS sources,
      origin.conversation_id AS "conversationId", conversation.title AS "conversationTitle"
    FROM review_invitations r
    JOIN conversation_turns origin ON origin.user_id = r.user_id AND origin.request_id = r.origin_request_id
    LEFT JOIN conversations conversation ON conversation.user_id = r.user_id AND conversation.id = origin.conversation_id
    WHERE r.user_id = $1 ORDER BY r.due_at, r.id
  `, [userId]);
  const { rows: attempts } = await db.query<{ invitationId: string; result: ReviewResult; note: string; answeredAt: Date }>(`
    SELECT review_invitation_id AS "invitationId", outcome AS result, note, answered_at AS "answeredAt"
    FROM review_attempts WHERE user_id = $1 ORDER BY answered_at, request_id
  `, [userId]);
  const stopped = new Set((await db.query<{ originRequestId: string }>(
    'SELECT origin_request_id AS "originRequestId" FROM review_topic_stops WHERE user_id = $1', [userId],
  )).rows.map(row => row.originRequestId));
  const { rows: [user] } = await db.query<{ enabled: boolean }>(
    "SELECT review_reminders_enabled AS enabled FROM users WHERE id = $1", [userId],
  );

  const topics = new Map<string, LearningTopic & { lastActivity: number }>();
  for (const invitation of invitations) {
    const latest = invitation.proposal;
    const topic = topics.get(invitation.originRequestId) ?? {
      originRequestId: invitation.originRequestId, topic: latest.topic, sourceLabel: latest.source.label,
      conversationId: invitation.conversationId, conversationTitle: invitation.conversationTitle,
      attempts: [], nextReviewAt: null, stopped: stopped.has(invitation.originRequestId), lastActivity: 0,
    };
    // Invitations come in due order, so the last one seen carries the current topic wording.
    topic.topic = latest.topic;
    topic.sourceLabel = latest.source.label;
    const pending = !invitation.questionRequestId && !invitation.cancelled
      && reviewSourceAvailable(invitation.discussionVersion, invitation.sources, latest.source);
    if (pending) topic.nextReviewAt = invitation.dueAt.toISOString();
    for (const attempt of attempts.filter(item => item.invitationId === invitation.id)) {
      topic.attempts.push({ answeredAt: attempt.answeredAt.toISOString(), result: attempt.result, note: attempt.note });
      topic.lastActivity = Math.max(topic.lastActivity, attempt.answeredAt.getTime());
    }
    topic.lastActivity = Math.max(topic.lastActivity, invitation.dueAt.getTime());
    topics.set(invitation.originRequestId, topic);
  }
  const ordered = [...topics.values()].sort((a, b) => b.lastActivity - a.lastActivity)
    .map(({ lastActivity: _lastActivity, ...topic }) => topic);
  return { remindersEnabled: user?.enabled === true, topics: ordered };
}

// Stopping a topic cancels its pending invitation and keeps later proposals from it unscheduled.
// Resuming reminders turns invitations back on for every topic that is not stopped.
export async function applyLearningCommand(db: PoolClient, userId: string, command: LearningCommand) {
  if (command.operation === "resume_reminders") {
    await db.query("UPDATE users SET review_reminders_enabled = true WHERE id = $1", [userId]);
    return true;
  }
  const { rowCount } = await db.query(
    "SELECT 1 FROM review_invitations WHERE user_id = $1 AND origin_request_id = $2", [userId, command.originRequestId],
  );
  if (!rowCount) return false;
  await db.query(`
    INSERT INTO review_topic_stops (user_id, origin_request_id) VALUES ($1, $2) ON CONFLICT DO NOTHING
  `, [userId, command.originRequestId]);
  await db.query(`
    UPDATE review_invitations SET cancelled = true
    WHERE user_id = $1 AND origin_request_id = $2 AND question_request_id IS NULL AND NOT cancelled
  `, [userId, command.originRequestId]);
  return true;
}
