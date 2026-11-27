import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ReviewInvitationCommand } from "../../contracts/conversation.js";
import { applyReviewInvitationCommand } from "../../review/invitations.js";
import { inTransaction } from "../../storage/transaction.js";
import { touchConversation } from "./conversations.js";

export function runReviewInvitationCommand(pool: Pool, userId: string, command: ReviewInvitationCommand, now: Date) {
  return inTransaction(pool, async db => {
    await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    return applyReviewInvitationCommand(db, userId, command, now, (reviewInvitationId, question) =>
      publishReviewQuestion(db, userId, command.conversationId, command.commandId, reviewInvitationId, question));
  });
}

// An invitation belongs to the user, so the question is published in whichever conversation accepted it.
async function publishReviewQuestion(
  db: PoolClient, userId: string, conversationId: string, requestId: string, reviewInvitationId: string, question: string,
) {
  const { rowCount: generating } = await db.query(`
    SELECT 1 FROM conversation_turns
    WHERE user_id = $1 AND conversation_id = $2 AND status = 'pending' AND lease_until > clock_timestamp()
  `, [userId, conversationId]);
  if (generating) return false;
  if (!await touchConversation(db, userId, conversationId, question)) return false;
  const questionBlocks = JSON.stringify([{ id: randomUUID(), kind: "text", text: question }]);
  const inserted = await db.query(`
    INSERT INTO conversation_turns (user_id, conversation_id, request_id, question_blocks, status, review_invitation_id, kind)
    VALUES ($1, $2, $3, $4, 'complete', $5, 'review_question') ON CONFLICT (user_id, request_id) DO NOTHING
  `, [userId, conversationId, requestId, questionBlocks, reviewInvitationId]);
  if (inserted.rowCount !== 1) return false;
  await db.query(`
    UPDATE conversation_turns SET status = 'failed', lease_until = NULL
    WHERE user_id = $1 AND conversation_id = $2 AND status IN ('pending', 'retryable') AND request_id <> $3
  `, [userId, conversationId, requestId]);
  return true;
}
