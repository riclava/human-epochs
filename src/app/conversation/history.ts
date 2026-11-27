import type { PoolClient } from 'pg'
import type { UserConversationTurn } from '../../contracts/conversation.js'

export const discussionChain = `
  WITH RECURSIVE chain AS (
    SELECT t.* FROM conversation_turns t WHERE user_id = $1 AND request_id = $2 AND material_context IS NOT NULL
    UNION ALL
    SELECT t.* FROM conversation_turns t JOIN chain c ON t.user_id = c.user_id
      AND t.request_id = (c.material_selection->>'parentRequestId')::uuid
  )
`

export interface HistoryTurn {
  requestId: string
  messageText: string
  replyBlocks: UserConversationTurn['replyBlocks']
  explanationSource: UserConversationTurn['explanationSource']
  memoryIds: string[]
}

export async function readHistory(db: PoolClient, userId: string, requestId: string, question: string, material: boolean) {
  const scope = material
    ? `${discussionChain}, recent AS (
        SELECT * FROM chain WHERE request_id <> $2 AND status = 'complete' ORDER BY position DESC LIMIT 60
      )`
    : `WITH recent AS (
        SELECT t.* FROM conversation_turns t
        JOIN conversation_turns asked ON asked.user_id = t.user_id AND asked.request_id = $2
        WHERE t.user_id = $1 AND t.conversation_id = asked.conversation_id AND t.position < asked.position
          AND t.status = 'complete' AND t.material_context IS NULL AND t.review_invitation_id IS NULL
        ORDER BY t.position DESC LIMIT 60
      )`
  const history = await db.query<HistoryTurn>(`
    ${scope}
    SELECT t.request_id AS "requestId", t.message_text AS "messageText", t.explanation_source AS "explanationSource",
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM conversation_memory_sources s JOIN personal_memories m ON m.user_id = s.user_id AND m.id = s.memory_id
        WHERE s.user_id = $1 AND s.request_id = t.request_id
          AND (m.body IS NULL OR NOT m.authorized_for_tutoring OR m.expires_at <= clock_timestamp()
            OR (m.topic <> '' AND strpos(lower($3), lower(m.topic)) = 0))
      ) THEN t.reply_blocks END AS "replyBlocks",
      ARRAY(SELECT s.memory_id FROM conversation_memory_sources s WHERE s.user_id = $1 AND s.request_id = t.request_id) AS "memoryIds"
    FROM recent t ORDER BY t.position
  `, [userId, requestId, question])
  return history.rows
}
