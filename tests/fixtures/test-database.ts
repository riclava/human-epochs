import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before } from 'node:test'
import { Pool } from 'pg'
import type { createApp } from '../../src/app/create-app.js'
import { migrate } from '../../src/storage/migrate.js'
import { seed } from '../../src/storage/seed.js'

// Creates a migrated, seeded database for one test file and drops it afterwards.
export function useTestDatabase() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('Set DATABASE_URL before running database tests')
  const admin = new Pool({ connectionString: databaseUrl })
  const databaseName = 'human_epochs_test_' + randomUUID().replaceAll('-', '')
  const testUrl = new URL(databaseUrl)
  testUrl.pathname = '/' + databaseName
  const pool = new Pool({ connectionString: testUrl.toString() })
  let created = false

  before(async () => {
    await admin.query('CREATE DATABASE "' + databaseName + '"')
    created = true
    await migrate(pool)
    await seed(pool)
  })

  after(async () => {
    await pool.end()
    if (created) await admin.query('DROP DATABASE "' + databaseName + '"')
    await admin.end()
  })

  return pool
}

export async function login(server: ReturnType<typeof createApp>, email: string) {
  const response = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'HumanEpochs-demo-1!' } })
  assert.equal(response.statusCode, 200)
  return String(response.headers['set-cookie']).split(';')[0]!
}
