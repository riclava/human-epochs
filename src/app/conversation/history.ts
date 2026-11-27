import type { PoolClient } from 'pg'
import type { UserConversationTurn } from '../../contracts/conversation.js'
import { memoryApplies } from '../memory-relevance.js'

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
  // A reply that used a memory leaves the history once that memory is gone, revoked or expired. While it is still
  // valid, a memory with a topic keeps the reply only for questions it applies to, by the same rule recall uses.
  const history = await db.query<HistoryTurn & { scopes: { topic: string; body: string }[] }>(`
    ${scope}
    SELECT t.request_id AS "requestId", t.message_text AS "messageText", t.explanation_source AS "explanationSource",
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM conversation_memory_sources s JOIN personal_memories m ON m.user_id = s.user_id AND m.id = s.memory_id
        WHERE s.user_id = $1 AND s.request_id = t.request_id
          AND (m.body IS NULL OR NOT m.authorized_for_tutoring OR m.expires_at <= clock_timestamp())
      ) THEN t.reply_blocks END AS "replyBlocks",
      ARRAY(SELECT s.memory_id FROM conversation_memory_sources s WHERE s.user_id = $1 AND s.request_id = t.request_id) AS "memoryIds",
      ARRAY(
        SELECT jsonb_build_object('topic', m.topic, 'body', m.body) FROM conversation_memory_sources s
        JOIN personal_memories m ON m.user_id = s.user_id AND m.id = s.memory_id
        WHERE s.user_id = $1 AND s.request_id = t.request_id AND m.body IS NOT NULL AND m.topic <> ''
      ) AS scopes
    FROM recent t ORDER BY t.position
  `, [userId, requestId])
  return history.rows.map(({ scopes, ...turn }) =>
    scopes.every(memory => memoryApplies(question, memory)) ? turn : { ...turn, replyBlocks: null })
}
