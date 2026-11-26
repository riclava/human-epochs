import type { PoolClient } from 'pg'
import type { ChatTurn } from '../../contracts/chat.js'

export const discussionChain = `
  WITH RECURSIVE chain AS (
    SELECT t.* FROM chat_turns t WHERE learner_id = $1 AND request_id = $2 AND material_context IS NOT NULL
    UNION ALL
    SELECT t.* FROM chat_turns t JOIN chain c ON t.learner_id = c.learner_id
      AND t.request_id = (c.material_command->>'parentRequestId')::uuid
  )
`

export interface HistoryTurn {
  requestId: string
  text: string
  content: ChatTurn['content']
  explanationMode: ChatTurn['explanationMode']
  memoryIds: string[]
}

export async function readHistory(db: PoolClient, learnerId: string, requestId: string, question: string, material: boolean) {
  const scope = material
    ? `${discussionChain}, recent AS (
        SELECT * FROM chain WHERE request_id <> $2 AND status = 'complete' ORDER BY position DESC LIMIT 60
      )`
    : `WITH recent AS (
        SELECT * FROM chat_turns WHERE learner_id = $1 AND status = 'complete' AND material_context IS NULL
          AND position < (SELECT position FROM chat_turns WHERE learner_id = $1 AND request_id = $2)
        ORDER BY position DESC LIMIT 60
      )`
  const history = await db.query<HistoryTurn>(`
    ${scope}
    SELECT t.request_id AS "requestId", t.message_text AS text, t.explanation_mode AS "explanationMode",
      CASE WHEN NOT EXISTS (
        SELECT 1 FROM chat_memory_sources s JOIN personal_memories m ON m.learner_id = s.learner_id AND m.id = s.memory_id
        WHERE s.learner_id = $1 AND s.request_id = t.request_id
          AND (m.body IS NULL OR NOT m.authorized OR m.expires_at <= clock_timestamp()
            OR (m.topic <> '' AND strpos(lower($3), lower(m.topic)) = 0))
      ) THEN t.content_blocks END AS content,
      ARRAY(SELECT s.memory_id FROM chat_memory_sources s WHERE s.learner_id = $1 AND s.request_id = t.request_id) AS "memoryIds"
    FROM recent t ORDER BY t.position
  `, [learnerId, requestId, question])
  return history.rows
}
