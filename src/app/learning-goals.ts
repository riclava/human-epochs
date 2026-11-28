import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import {
  activeLearningGoalLimit, learningGoalLimit, type LearningGoal, type LearningGoalCommand, type LearningGoalList,
} from '../contracts/learning-goal.js'
import { inTransaction } from '../storage/transaction.js'

export type GoalRefusal = 'conflict' | 'missing' | 'limit' | 'invalid_proposal'
type GoalOutcome = { kind: 'saved'; list: LearningGoalList } | { kind: GoalRefusal }

export async function readLearningGoals(db: Pool | PoolClient, userId: string): Promise<LearningGoalList> {
  const { rows } = await db.query<LearningGoal & { updatedAt: Date }>(`
    SELECT id, revision, title, motivation, progress, status, proposal_block_id AS "proposalBlockId", updated_at AS "updatedAt"
    FROM learning_goals WHERE user_id = $1
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC, id
  `, [userId])
  return { goals: rows.map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })) }
}

// Every goal title, in any status, so the Agent does not propose a goal the user already has.
export async function readGoalTitles(db: Pool | PoolClient, userId: string) {
  const { rows } = await db.query<{ title: string }>('SELECT title FROM learning_goals WHERE user_id = $1', [userId])
  return rows.map(row => row.title)
}

// The goals an online conversation reads as background.
export async function readActiveGoals(db: Pool | PoolClient, userId: string) {
  const { rows } = await db.query<Pick<LearningGoal, 'title' | 'motivation' | 'progress'>>(`
    SELECT title, motivation, progress FROM learning_goals WHERE user_id = $1 AND status = 'active'
    ORDER BY updated_at DESC, id LIMIT ${activeLearningGoalLimit}
  `, [userId])
  return rows
}

// A proposal can be accepted only from the user's own published reply that contains it.
async function proposalExists(db: PoolClient, userId: string, proposal: { requestId: string; blockId: string }) {
  const { rowCount } = await db.query(`
    SELECT 1 FROM conversation_turns
    WHERE user_id = $1 AND request_id = $2 AND status = 'complete'
      AND reply_blocks @> jsonb_build_array(jsonb_build_object('kind', 'goal_proposal', 'id', $3::text))
  `, [userId, proposal.requestId, proposal.blockId])
  return !!rowCount
}

async function counts(db: PoolClient, userId: string, excluding: string | null) {
  const { rows: [row] } = await db.query<{ total: number; active: number }>(`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active
    FROM learning_goals WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2)
  `, [userId, excluding])
  return row!
}

async function create(db: PoolClient, userId: string, command: Extract<LearningGoalCommand, { operation: 'create' }>): Promise<GoalRefusal | null> {
  const { total, active } = await counts(db, userId, null)
  if (total >= learningGoalLimit || (command.status === 'active' && active >= activeLearningGoalLimit)) return 'limit'
  if (command.proposal && !await proposalExists(db, userId, command.proposal)) return 'invalid_proposal'
  const inserted = await db.query(`
    INSERT INTO learning_goals (user_id, id, title, motivation, progress, status, proposal_request_id, proposal_block_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING
  `, [userId, command.commandId, command.title, command.motivation, command.progress, command.status,
    command.proposal?.requestId ?? null, command.proposal?.blockId ?? null])
  return inserted.rowCount ? null : 'conflict'
}

async function change(db: PoolClient, userId: string, command: Exclude<LearningGoalCommand, { operation: 'create' }>): Promise<GoalRefusal | null> {
  const { rows: [current] } = await db.query<{ revision: number }>(
    'SELECT revision FROM learning_goals WHERE user_id = $1 AND id = $2', [userId, command.id])
  if (!current) return 'missing'
  if (current.revision !== command.expectedRevision) return 'conflict'
  if (command.operation === 'delete') {
    await db.query('DELETE FROM learning_goals WHERE user_id = $1 AND id = $2', [userId, command.id])
    return null
  }
  if (command.status === 'active' && (await counts(db, userId, command.id)).active >= activeLearningGoalLimit) return 'limit'
  await db.query(`
    UPDATE learning_goals SET title = $3, motivation = $4, progress = $5, status = $6, revision = revision + 1,
      updated_at = clock_timestamp()
    WHERE user_id = $1 AND id = $2
  `, [userId, command.id, command.title, command.motivation, command.progress, command.status])
  return null
}

function fingerprint(command: LearningGoalCommand) {
  const { commandId: _commandId, ...details } = command
  return createHash('sha256').update(JSON.stringify(details, Object.keys(details).sort())).digest('hex')
}

export function createLearningGoalService(pool: Pool) {
  // A command runs once; replaying it returns the current list, and reusing its ID for other content is a conflict.
  function run(userId: string, command: LearningGoalCommand): Promise<GoalOutcome> {
    return inTransaction(pool, async db => {
      await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId])
      const { rows: [receipt] } = await db.query<{ matches: boolean }>(`
        SELECT command_fingerprint = $3 AS matches FROM learning_goal_command_receipts WHERE user_id = $1 AND command_id = $2
      `, [userId, command.commandId, fingerprint(command)])
      if (receipt && !receipt.matches) return { kind: 'conflict' as const }
      if (!receipt) {
        const refusal = command.operation === 'create' ? await create(db, userId, command) : await change(db, userId, command)
        if (refusal) return { kind: refusal }
        await db.query(`
          INSERT INTO learning_goal_command_receipts (user_id, command_id, command_fingerprint) VALUES ($1, $2, $3)
        `, [userId, command.commandId, fingerprint(command)])
      }
      return { kind: 'saved' as const, list: await readLearningGoals(db, userId) }
    })
  }
  return { read: (userId: string) => readLearningGoals(pool, userId), run }
}
