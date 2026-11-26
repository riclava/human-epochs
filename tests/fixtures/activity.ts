import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { memoirCourse } from '../../src/curriculum/catalog.js'

// Use a separate activity so a scenario can change its revision without altering a demo activity.
export async function createTestActivity(pool: Pool) {
  const activityId = randomUUID()
  const added = await pool.query(`
    INSERT INTO activities (id, learner_id, title, course_version, revision)
    SELECT $1, a.learner_id, a.title, a.course_version, 1
    FROM activities a JOIN learners l ON l.id = a.learner_id
    WHERE l.email = 'alice@example.test' AND a.course_version = $2 LIMIT 1
  `, [activityId, memoirCourse.version])
  if (!added.rowCount) throw new Error('Seed the demo activity before running activity tests')
  return { activityId }
}

export async function removeTestActivity(pool: Pool, activityId: string) {
  await pool.query('DELETE FROM activities WHERE id = $1', [activityId])
}

export async function createTestLearner(pool: Pool) {
  const id = randomUUID()
  const email = 'material-' + id + '@example.test'
  const inserted = await pool.query(`
    INSERT INTO learners (id, email, display_name, password_hash)
    SELECT $1, $2, 'Learner', password_hash FROM learners WHERE email = 'alice@example.test'
  `, [id, email])
  if (!inserted.rowCount) throw new Error('Seed the demo accounts before running learner tests')
  return { id, email }
}

export async function removeTestLearner(pool: Pool, id: string) {
  await pool.query('DELETE FROM activities WHERE learner_id = $1', [id])
  await pool.query('DELETE FROM learners WHERE id = $1', [id])
}
