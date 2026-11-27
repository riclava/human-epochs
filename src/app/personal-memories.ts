import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { PersonalMemoryCommand, PersonalMemory, PersonalMemorySnapshot } from '../contracts/personal-memory.js'
import { inTransaction } from '../storage/transaction.js'
import { acceptCandidate, readCandidateState, rejectCandidate, setSuggestions } from './memory-candidates.js'

const columns = `id, revision, kind, body, topic, authorized_for_tutoring AS "authorizedForTutoring", expires_at AS "expiresAt",
  source_request_id AS "sourceRequestId"`

type Refusal = { kind: 'conflict' | 'missing' | 'invalid_source' }
type MemoryCommand = Extract<PersonalMemoryCommand, { operation: 'remember' | 'correct' | 'forget' }>

export async function readPersonalMemories(db: Pool | PoolClient, userId: string): Promise<PersonalMemorySnapshot> {
  const result = await db.query<PersonalMemory>(`
    SELECT ${columns} FROM personal_memories
    WHERE user_id = $1 AND body IS NOT NULL ORDER BY updated_at DESC, id
  `, [userId])
  return { memories: result.rows, ...await readCandidateState(db, userId) }
}

export async function recallPersonalMemories(
  db: PoolClient, userId: string, purpose: 'tutoring', question: string,
): Promise<PersonalMemory[]> {
  const result = await db.query<PersonalMemory>(`
    SELECT ${columns} FROM personal_memories
    WHERE user_id = $1 AND body IS NOT NULL AND authorized_for_tutoring AND $2 = 'tutoring'
      AND (expires_at IS NULL OR expires_at > clock_timestamp())
      AND (topic = '' OR strpos(lower($3), lower(topic)) > 0)
    ORDER BY (topic <> '') DESC, updated_at DESC, id LIMIT 8
  `, [userId, purpose, question])
  return result.rows
}

async function invalidateMemory(db: PoolClient, userId: string, id: string) {
  await db.query(`UPDATE users SET memory_revision = memory_revision + 1 WHERE id = $1`, [userId])
  await db.query(`
    UPDATE conversation_summaries SET status = 'failed', summary = NULL, lease_until = NULL
    WHERE user_id = $1 AND status <> 'failed'
  `, [userId])
  await db.query(`
    UPDATE conversation_turns t SET reply_blocks = (
      SELECT jsonb_agg(jsonb_build_object('kind', 'unavailable', 'id', block->>'id') ORDER BY position)
      FROM jsonb_array_elements(t.reply_blocks) WITH ORDINALITY AS b(block, position)
    )
    FROM conversation_memory_sources s
    WHERE s.user_id = $1 AND s.memory_id = $2
      AND t.user_id = s.user_id AND t.request_id = s.request_id AND t.kind = 'user' AND t.status = 'complete'
  `, [userId, id])
}

async function readSource(db: Pool | PoolClient, userId: string, requestId: string) {
  const source = await db.query<{ messageText: string }>(`
    SELECT message_text AS "messageText" FROM conversation_turns
    WHERE user_id = $1 AND request_id = $2 AND kind = 'user' AND status = 'complete'
  `, [userId, requestId])
  return source.rows[0]
}

async function changeMemory(db: PoolClient, userId: string, command: MemoryCommand): Promise<Refusal | null> {
  const id = command.operation === 'remember' ? command.commandId : command.id
  if (command.operation !== 'remember') {
    const current = await db.query<{ revision: number }>(`
      SELECT revision FROM personal_memories WHERE user_id = $1 AND id = $2 AND body IS NOT NULL
    `, [userId, id])
    if (!current.rows[0]) return { kind: 'missing' }
    if (current.rows[0].revision !== command.expectedRevision) return { kind: 'conflict' }
  }
  if (command.operation !== 'forget' && command.sourceRequestId && !await readSource(db, userId, command.sourceRequestId)) {
    return { kind: 'invalid_source' }
  }
  await writeMemory(db, userId, id, command)
  if (command.operation !== 'remember') await invalidateMemory(db, userId, id)
  return null
}

function applyCommand(db: PoolClient, userId: string, command: PersonalMemoryCommand): Promise<Refusal | null> {
  switch (command.operation) {
    case 'accept_candidate': return acceptCandidate(db, userId, command)
    case 'reject_candidate': return rejectCandidate(db, userId, command.candidateId)
    case 'set_suggestions': return setSuggestions(db, userId, command.enabled).then(() => null)
    default: return changeMemory(db, userId, command)
  }
}

export function createPersonalMemoryService(pool: Pool) {
  function change(userId: string, command: PersonalMemoryCommand) {
    const fingerprint = fingerprintCommand(command)
    return inTransaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      const received = await db.query<{ matches: boolean }>(`
        SELECT command_fingerprint = $3 AS matches
        FROM personal_memory_command_receipts WHERE user_id = $1 AND command_id = $2
      `, [userId, command.commandId, fingerprint])
      const receipt = received.rows[0]
      if (receipt && !receipt.matches) return { kind: 'conflict' } as const
      if (!receipt) {
        const refusal = await applyCommand(db, userId, command)
        if (refusal) return refusal
        await db.query(`
          INSERT INTO personal_memory_command_receipts (user_id, command_id, command_fingerprint) VALUES ($1, $2, $3)
        `, [userId, command.commandId, fingerprint])
      }
      return { kind: 'saved', snapshot: await readPersonalMemories(db, userId) } as const
    })
  }
  return {
    read: (userId: string) => readPersonalMemories(pool, userId),
    source: (userId: string, requestId: string) => readSource(pool, userId, requestId),
    change,
  }
}

function fingerprintCommand(command: PersonalMemoryCommand) {
  const { commandId: _commandId, ...details } = command
  const fields = Object.keys(details).sort()
  return createHash('sha256').update(JSON.stringify(details, fields)).digest('hex')
}

async function writeMemory(db: PoolClient, userId: string, id: string, command: MemoryCommand) {
  if (command.operation === 'forget') {
    await db.query(`
      UPDATE personal_memories SET body = NULL, topic = '', authorized_for_tutoring = false, expires_at = NULL,
        source_request_id = NULL, revision = revision + 1, updated_at = clock_timestamp()
      WHERE user_id = $1 AND id = $2
    `, [userId, id])
    return
  }
  await db.query(`
    INSERT INTO personal_memories (user_id, id, kind, body, topic, authorized_for_tutoring, expires_at, source_request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (user_id, id) DO UPDATE SET kind = EXCLUDED.kind, body = EXCLUDED.body, topic = EXCLUDED.topic,
      authorized_for_tutoring = EXCLUDED.authorized_for_tutoring, expires_at = EXCLUDED.expires_at, source_request_id = EXCLUDED.source_request_id,
      revision = personal_memories.revision + 1, updated_at = clock_timestamp()
  `, [userId, id, command.kind, command.body, command.topic, command.authorizedForTutoring, command.expiresAt, command.sourceRequestId ?? null])
}
