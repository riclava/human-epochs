import type { Pool, PoolClient } from 'pg'
import type { MemoryCommand, PersonalMemory } from '../../contracts/memory.js'
import { inTransaction } from '../../storage/transaction.js'

const columns = `id, revision, kind, body, topic, authorized, expires_at AS "expiresAt",
  source_request_id AS "sourceRequestId"`

async function readMemories(db: Pool | PoolClient, learnerId: string) {
  const result = await db.query<PersonalMemory>(`
    SELECT ${columns} FROM personal_memories
    WHERE learner_id = $1 AND body IS NOT NULL ORDER BY updated_at DESC, id
  `, [learnerId])
  return { memories: result.rows }
}

export async function recallMemories(
  db: PoolClient, learnerId: string, purpose: 'learning', question: string,
): Promise<PersonalMemory[]> {
  const result = await db.query<PersonalMemory>(`
    SELECT ${columns} FROM personal_memories
    WHERE learner_id = $1 AND body IS NOT NULL AND authorized AND $2 = 'learning'
      AND (expires_at IS NULL OR expires_at > clock_timestamp())
      AND (topic = '' OR strpos(lower($3), lower(topic)) > 0)
    ORDER BY (topic <> '') DESC, updated_at DESC, id LIMIT 8
  `, [learnerId, purpose, question])
  return result.rows
}

async function invalidateMemory(db: PoolClient, learnerId: string, id: string) {
  await db.query(`UPDATE learners SET memory_revision = memory_revision + 1 WHERE id = $1`, [learnerId])
  await db.query(`
    UPDATE conversation_summaries SET status = 'failed', summary = NULL, lease_until = NULL
    WHERE learner_id = $1 AND status <> 'failed'
  `, [learnerId])
  await db.query(`
    UPDATE chat_turns t SET content_blocks = (
      SELECT jsonb_agg(jsonb_build_object('kind', 'unavailable', 'id', block->>'id') ORDER BY position)
      FROM jsonb_array_elements(t.content_blocks) WITH ORDINALITY AS b(block, position)
    )
    FROM chat_memory_sources s
    WHERE s.learner_id = $1 AND s.memory_id = $2
      AND t.learner_id = s.learner_id AND t.request_id = s.request_id AND t.status = 'complete'
  `, [learnerId, id])
}

async function readSource(db: Pool | PoolClient, learnerId: string, requestId: string) {
  const source = await db.query<{ text: string }>(`
    SELECT message_text AS text FROM chat_turns WHERE learner_id = $1 AND request_id = $2 AND status = 'complete'
  `, [learnerId, requestId])
  return source.rows[0]
}

export function createPersonalMemoryService(pool: Pool) {
  function change(learnerId: string, command: MemoryCommand) {
    return inTransaction(pool, async db => {
      await db.query('SELECT id FROM learners WHERE id = $1 FOR UPDATE', [learnerId])
      const id = command.operation === 'remember' ? command.commandId : command.id
      const received = await db.query<{ memoryId: string; operation: string; revision: number }>(`
        SELECT memory_id AS "memoryId", operation, result_revision AS revision
        FROM memory_command_receipts WHERE learner_id = $1 AND command_id = $2
      `, [learnerId, command.commandId])
      const receipt = received.rows[0]
      if (receipt) {
        if (receipt.memoryId !== id || receipt.operation !== command.operation
          || !await matchesReceipt(db, learnerId, id, receipt.revision, command)) return { kind: 'conflict' } as const
        return { kind: 'saved', snapshot: await readMemories(db, learnerId) } as const
      }

      if (command.operation !== 'remember') {
        const current = await db.query<{ revision: number }>(`
          SELECT revision FROM personal_memories WHERE learner_id = $1 AND id = $2 AND body IS NOT NULL
        `, [learnerId, id])
        if (!current.rows[0]) return { kind: 'missing' } as const
        if (current.rows[0].revision !== command.revision) return { kind: 'conflict' } as const
      }
      if (command.operation !== 'forget' && command.sourceRequestId && !await readSource(db, learnerId, command.sourceRequestId)) {
        return { kind: 'invalid_source' } as const
      }

      const revision = await writeMemory(db, learnerId, id, command)
      if (command.operation !== 'remember') await invalidateMemory(db, learnerId, id)
      await db.query(`
        INSERT INTO memory_command_receipts (learner_id, command_id, memory_id, operation, result_revision)
        VALUES ($1, $2, $3, $4, $5)
      `, [learnerId, command.commandId, id, command.operation, revision])
      return { kind: 'saved', snapshot: await readMemories(db, learnerId) } as const
    })
  }
  return {
    read: (learnerId: string) => readMemories(pool, learnerId),
    source: (learnerId: string, requestId: string) => readSource(pool, learnerId, requestId),
    change,
  }
}

async function matchesReceipt(db: PoolClient, learnerId: string, id: string, revision: number, command: MemoryCommand) {
  if (command.operation === 'forget') return true
  const result = await db.query(`
    SELECT 1 FROM personal_memories WHERE learner_id = $1 AND id = $2
      AND (revision > $3 OR (kind = $4 AND body = $5 AND topic = $6 AND authorized = $7
        AND expires_at IS NOT DISTINCT FROM $8 AND source_request_id IS NOT DISTINCT FROM $9))
  `, [learnerId, id, revision, command.kind, command.body, command.topic, command.authorized,
    command.expiresAt, command.sourceRequestId ?? null])
  return !!result.rowCount
}

async function writeMemory(db: PoolClient, learnerId: string, id: string, command: MemoryCommand) {
  if (command.operation === 'forget') {
    const result = await db.query<{ revision: number }>(`
      UPDATE personal_memories SET body = NULL, topic = '', authorized = false, expires_at = NULL,
        source_request_id = NULL, revision = revision + 1, updated_at = clock_timestamp()
      WHERE learner_id = $1 AND id = $2 RETURNING revision
    `, [learnerId, id])
    return result.rows[0].revision
  }
  const result = await db.query<{ revision: number }>(`
    INSERT INTO personal_memories (learner_id, id, kind, body, topic, authorized, expires_at, source_request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (learner_id, id) DO UPDATE SET kind = EXCLUDED.kind, body = EXCLUDED.body, topic = EXCLUDED.topic,
      authorized = EXCLUDED.authorized, expires_at = EXCLUDED.expires_at, source_request_id = EXCLUDED.source_request_id,
      revision = personal_memories.revision + 1, updated_at = clock_timestamp()
    RETURNING revision
  `, [learnerId, id, command.kind, command.body, command.topic, command.authorized, command.expiresAt, command.sourceRequestId ?? null])
  return result.rows[0].revision
}
