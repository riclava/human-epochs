import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ReviewInvitationCommand } from "../../contracts/conversation.js";
import { applyReviewInvitationCommand } from "../../review/invitations.js";
import { inTransaction } from "../../storage/transaction.js";

export function runReviewInvitationCommand(pool: Pool, userId: string, command: ReviewInvitationCommand, now: Date) {
  return inTransaction(pool, async db => {
    await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    return applyReviewInvitationCommand(db, userId, command, now,
      (reviewInvitationId, question) => publishReviewQuestion(db, userId, command.commandId, reviewInvitationId, question));
  });
}

async function publishReviewQuestion(db: PoolClient, userId: string, requestId: string, reviewInvitationId: string, question: string) {
  const questionBlocks = JSON.stringify([{ id: randomUUID(), kind: "text", text: question }]);
  const inserted = await db.query(`
    WITH published AS (
      INSERT INTO conversation_turns (user_id, request_id, question_blocks, status, review_invitation_id, kind)
      SELECT $1::uuid, $2::uuid, $3::jsonb, 'complete', $4::uuid, 'review_question' WHERE NOT EXISTS (
        SELECT 1 FROM conversation_turns WHERE user_id = $1 AND status = 'pending' AND lease_until > clock_timestamp()
      ) ON CONFLICT (user_id, request_id) DO NOTHING RETURNING request_id
    ), closed AS (
      UPDATE conversation_turns SET status = 'failed', lease_until = NULL
      WHERE user_id = $1 AND status IN ('pending', 'retryable') AND EXISTS (SELECT 1 FROM published)
    )
    SELECT request_id FROM published
  `, [userId, requestId, questionBlocks, reviewInvitationId]);
  return inserted.rowCount === 1;
}
