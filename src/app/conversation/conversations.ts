import type { Pool, PoolClient } from "pg";
import { conversationTitle, type ConversationList } from "../../contracts/conversation.js";

// Creates the conversation on its first turn and marks it as recently used on every later turn.
// The title comes from the first turn only.
export async function touchConversation(db: PoolClient, userId: string, conversationId: string, firstText: string) {
  await db.query(`
    INSERT INTO conversations (user_id, id, title) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, id) DO UPDATE SET updated_at = clock_timestamp()
  `, [userId, conversationId, conversationTitle(firstText) || "新对话"]);
}

export async function readConversationTitle(db: Pool | PoolClient, userId: string, conversationId: string) {
  const { rows: [conversation] } = await db.query<{ title: string }>(
    "SELECT title FROM conversations WHERE user_id = $1 AND id = $2", [userId, conversationId],
  );
  return conversation?.title ?? null;
}

export async function listConversations(pool: Pool, userId: string): Promise<ConversationList> {
  const { rows } = await pool.query<{ conversationId: string; title: string; updatedAt: Date }>(`
    SELECT id AS "conversationId", title, updated_at AS "updatedAt" FROM conversations
    WHERE user_id = $1 ORDER BY updated_at DESC, id LIMIT 200
  `, [userId]);
  return { conversations: rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })) };
}
