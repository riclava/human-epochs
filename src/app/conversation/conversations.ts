import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { conversationTitle, type ConversationCommand, type ConversationList } from "../../contracts/conversation.js";
import { inTransaction } from "../../storage/transaction.js";

export async function isDeletedConversation(db: Pool | PoolClient, userId: string, conversationId: string) {
  const { rowCount } = await db.query("SELECT 1 FROM deleted_conversations WHERE user_id = $1 AND id = $2", [userId, conversationId]);
  return rowCount === 1;
}

// Creates the conversation on its first turn and marks it as recently used on every later turn.
// The title comes from the first turn only. A deleted conversation is never recreated.
export async function touchConversation(db: PoolClient, userId: string, conversationId: string, firstText: string) {
  if (await isDeletedConversation(db, userId, conversationId)) return false;
  await db.query(`
    INSERT INTO conversations (user_id, id, title) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, id) DO UPDATE SET updated_at = clock_timestamp()
  `, [userId, conversationId, conversationTitle(firstText) || "新对话"]);
  return true;
}

export async function readConversationTitle(db: Pool | PoolClient, userId: string, conversationId: string) {
  const { rows: [conversation] } = await db.query<{ title: string }>(
    "SELECT title FROM conversations WHERE user_id = $1 AND id = $2", [userId, conversationId],
  );
  return conversation?.title ?? null;
}

export async function listConversations(db: Pool | PoolClient, userId: string): Promise<ConversationList> {
  const { rows } = await db.query<{ conversationId: string; title: string; updatedAt: Date }>(`
    SELECT id AS "conversationId", title, updated_at AS "updatedAt" FROM conversations
    WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT 200
  `, [userId]);
  return { conversations: rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })) };
}

// Deleting a conversation removes its turns and everything derived only from them: replies, review invitations,
// memory suggestions, extraction jobs and summaries. Records the user confirmed elsewhere survive: a personal memory
// saved from one of its messages loses only its source link, and an activity started from a discussion loses only
// the link to that discussion.
async function deleteConversation(db: PoolClient, userId: string, conversationId: string) {
  const turns = "SELECT request_id FROM conversation_turns WHERE user_id = $1 AND conversation_id = $2";
  await db.query(`UPDATE personal_memories SET source_request_id = NULL WHERE user_id = $1 AND source_request_id IN (${turns})`,
    [userId, conversationId]);
  await db.query(`
    DELETE FROM discussion_activities WHERE user_id = $1 AND (discussion_id IN (${turns}) OR source_request_id IN (${turns}))
  `, [userId, conversationId]);
  const deleted = await db.query("DELETE FROM conversations WHERE user_id = $1 AND id = $2", [userId, conversationId]);
  if (!deleted.rowCount) return false;
  await db.query("INSERT INTO deleted_conversations (user_id, id) VALUES ($1, $2)", [userId, conversationId]);
  return true;
}

async function renameConversation(db: PoolClient, userId: string, conversationId: string, title: string) {
  const renamed = await db.query("UPDATE conversations SET title = $3 WHERE user_id = $1 AND id = $2", [userId, conversationId, title]);
  return renamed.rowCount === 1;
}

export function runConversationCommand(pool: Pool, userId: string, conversationId: string, command: ConversationCommand) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([conversationId, command.operation, command.operation === "rename" ? command.title : null])).digest("hex");
  return inTransaction(pool, async db => {
    await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const { rows: [receipt] } = await db.query<{ matches: boolean }>(`
      SELECT command_fingerprint = $3 AS matches FROM conversation_command_receipts WHERE user_id = $1 AND command_id = $2
    `, [userId, command.commandId, fingerprint]);
    if (receipt) return receipt.matches ? { kind: "saved", list: await listConversations(db, userId) } as const : { kind: "conflict" } as const;
    const done = command.operation === "delete"
      ? await deleteConversation(db, userId, conversationId)
      : await renameConversation(db, userId, conversationId, command.title);
    if (!done) return { kind: "missing" } as const;
    await db.query(`
      INSERT INTO conversation_command_receipts (user_id, command_id, command_fingerprint) VALUES ($1, $2, $3)
    `, [userId, command.commandId, fingerprint]);
    return { kind: "saved", list: await listConversations(db, userId) } as const;
  });
}
