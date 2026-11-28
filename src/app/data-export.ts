import type { Pool, PoolClient } from "pg";
import { conversationContentText, type ConversationContent } from "../contracts/conversation.js";
import { inTransaction } from "../storage/transaction.js";

// Everything the user wrote or kept, in one readable file. Internal bookkeeping (sessions, receipts, background jobs,
// summaries and password hashes) stays out; it can be rebuilt and means nothing outside the service.
export const exportFormat = { name: "human-epochs-export", version: 1 } as const;

type Turn = {
  conversationId: string; requestId: string; kind: "user" | "review_question"; status: string; messageText: string | null;
  replyBlocks: ConversationContent | null; questionBlocks: ConversationContent | null;
  materialContext: { sources: { id: string; label?: string; deleted?: boolean }[] } | null;
};

async function conversations(db: PoolClient, userId: string) {
  const { rows: list } = await db.query<{ id: string; title: string; createdAt: Date; updatedAt: Date }>(`
    SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM conversations WHERE user_id = $1 ORDER BY created_at, id
  `, [userId]);
  const { rows: turns } = await db.query<Turn>(`
    SELECT conversation_id AS "conversationId", request_id AS "requestId", kind, status, message_text AS "messageText",
      reply_blocks AS "replyBlocks", question_blocks AS "questionBlocks", material_context AS "materialContext"
    FROM conversation_turns WHERE user_id = $1 ORDER BY position
  `, [userId]);
  return list.map(conversation => ({
    ...conversation,
    turns: turns.filter(turn => turn.conversationId === conversation.id).map(turn => ({
      requestId: turn.requestId,
      kind: turn.kind,
      status: turn.status,
      ...(turn.messageText !== null ? { message: turn.messageText } : {}),
      // The reply as plain text for reading, and its blocks for anything that wants the structure.
      reply: conversationContentText(turn.replyBlocks ?? turn.questionBlocks),
      blocks: turn.replyBlocks ?? turn.questionBlocks,
      ...(turn.materialContext ? {
        sources: turn.materialContext.sources.map(source => source.deleted ? { id: source.id, deleted: true } : { id: source.id, label: source.label }),
      } : {}),
    })),
  }));
}

async function reviews(db: PoolClient, userId: string) {
  const { rows } = await db.query<{
    id: string; originRequestId: string; dueAt: Date; proposal: { topic: string; question: string; answer: string; quote: string }; stopped: boolean;
  }>(`
    SELECT i.id, i.origin_request_id AS "originRequestId", i.due_at AS "dueAt", i.proposal,
      EXISTS (SELECT 1 FROM review_topic_stops s WHERE s.user_id = i.user_id AND s.origin_request_id = i.origin_request_id) AS stopped
    FROM review_invitations i WHERE i.user_id = $1 AND NOT i.cancelled ORDER BY i.due_at, i.id
  `, [userId]);
  const { rows: attempts } = await db.query<{ invitationId: string; outcome: string; note: string; answeredAt: Date }>(`
    SELECT review_invitation_id AS "invitationId", outcome, note, answered_at AS "answeredAt"
    FROM review_attempts WHERE user_id = $1 ORDER BY answered_at
  `, [userId]);
  return rows.map(({ proposal, ...review }) => ({
    ...review, topic: proposal.topic, question: proposal.question, answer: proposal.answer, quote: proposal.quote,
    attempts: attempts.filter(attempt => attempt.invitationId === review.id).map(({ invitationId: _id, ...attempt }) => attempt),
  }));
}

export function exportUserData(pool: Pool, userId: string, now = () => new Date()) {
  // One repeatable-read snapshot, so the parts agree with each other even while another device writes.
  return inTransaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [account] } = await db.query<{ email: string; displayName: string; reviewReminders: boolean; memorySuggestions: boolean }>(`
      SELECT email, display_name AS "displayName", review_reminders_enabled AS "reviewReminders",
        memory_suggestions_enabled AS "memorySuggestions" FROM users WHERE id = $1
    `, [userId]);
    if (!account) return null;
    const { rows: materials } = await db.query(`
      SELECT id, label, length, created_at AS "createdAt", text FROM materials WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at, id
    `, [userId]);
    const { rows: memories } = await db.query(`
      SELECT id, kind, body, topic, authorized_for_tutoring AS "authorizedForTutoring", expires_at AS "expiresAt",
        source_request_id AS "sourceRequestId", updated_at AS "updatedAt"
      FROM personal_memories WHERE user_id = $1 AND body IS NOT NULL ORDER BY updated_at, id
    `, [userId]);
    const { rows: goals } = await db.query(`
      SELECT id, title, motivation, progress, status, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM learning_goals WHERE user_id = $1 ORDER BY created_at, id
    `, [userId]);
    return {
      format: exportFormat.name, version: exportFormat.version, exportedAt: now().toISOString(),
      account,
      conversations: await conversations(db, userId),
      materials, memories, goals,
      reviews: await reviews(db, userId),
    };
  });
}
