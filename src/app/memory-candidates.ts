import type { Pool, PoolClient } from 'pg'
import type { PersonalMemoryCandidate, PersonalMemoryCommand } from '../contracts/personal-memory.js'

type AcceptCommand = Extract<PersonalMemoryCommand, { operation: 'accept_candidate' }>

export async function readCandidateState(db: Pool | PoolClient, userId: string) {
  const candidates = await db.query<PersonalMemoryCandidate>(`
    SELECT id, kind, body, quote, reason, topic, suggested_for_tutoring AS "suggestedForTutoring",
      source_request_id AS "sourceRequestId"
    FROM personal_memory_candidates WHERE user_id = $1 AND status = 'pending' ORDER BY created_at, id
  `, [userId])
  const settings = await db.query<{ suggestionsEnabled: boolean; suggestionsPending: boolean }>(`
    SELECT memory_suggestions_enabled AS "suggestionsEnabled", memory_suggestions_enabled AND EXISTS (
      SELECT 1 FROM personal_memory_extractions WHERE user_id = $1 AND status = 'pending' AND attempt < 3
    ) AS "suggestionsPending"
    FROM users WHERE id = $1
  `, [userId])
  return { candidates: candidates.rows, ...settings.rows[0] ?? { suggestionsEnabled: false, suggestionsPending: false } }
}

// Called in the reply publication transaction. Review answers stay in the review domain.
export async function enqueueExtraction(db: PoolClient, userId: string, requestId: string) {
  await db.query(`
    INSERT INTO personal_memory_extractions (user_id, source_request_id)
    SELECT u.id, t.request_id FROM users u
    JOIN conversation_turns t ON t.user_id = u.id AND t.request_id = $2
    WHERE u.id = $1 AND u.memory_suggestions_enabled
      AND t.kind = 'user' AND t.status = 'complete' AND t.review_invitation_id IS NULL
    ON CONFLICT DO NOTHING
  `, [userId, requestId])
}

async function decide(db: PoolClient, userId: string, candidateId: string | null, status: 'accepted' | 'rejected' | 'dismissed') {
  const result = await db.query(`
    UPDATE personal_memory_candidates SET status = $3,
      kind = NULL, body = NULL, quote = NULL, reason = NULL, topic = NULL, suggested_for_tutoring = NULL
    WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2) AND status = 'pending'
  `, [userId, candidateId, status])
  return result.rowCount ?? 0
}

export async function acceptCandidate(db: PoolClient, userId: string, command: AcceptCommand) {
  const { rows: [candidate] } = await db.query<{ sourceRequestId: string }>(`
    SELECT c.source_request_id AS "sourceRequestId" FROM personal_memory_candidates c
    JOIN conversation_turns t ON t.user_id = c.user_id AND t.request_id = c.source_request_id
      AND t.kind = 'user' AND t.status = 'complete'
    WHERE c.user_id = $1 AND c.id = $2 AND c.status = 'pending' FOR UPDATE OF c
  `, [userId, command.candidateId])
  if (!candidate) return { kind: 'missing' } as const
  // The accepted record reuses the candidate ID, so both devices converge on one memory.
  const inserted = await db.query(`
    INSERT INTO personal_memories (user_id, id, kind, body, topic, authorized_for_tutoring, expires_at, source_request_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING
  `, [userId, command.candidateId, command.kind, command.body, command.topic, command.authorizedForTutoring,
    command.expiresAt, candidate.sourceRequestId])
  if (!inserted.rowCount) return { kind: 'conflict' } as const
  await decide(db, userId, command.candidateId, 'accepted')
  return null
}

export async function rejectCandidate(db: PoolClient, userId: string, candidateId: string) {
  return await decide(db, userId, candidateId, 'rejected') ? null : { kind: 'missing' } as const
}

export async function setSuggestions(db: PoolClient, userId: string, enabled: boolean) {
  await db.query('UPDATE users SET memory_suggestions_enabled = $2 WHERE id = $1', [userId, enabled])
  if (enabled) return
  await db.query(`
    UPDATE personal_memory_extractions SET status = 'cancelled', lease_until = NULL
    WHERE user_id = $1 AND status = 'pending'
  `, [userId])
  await decide(db, userId, null, 'dismissed')
}
