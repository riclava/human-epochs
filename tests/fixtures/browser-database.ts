import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Pool } from 'pg'
import { migrate } from '../../src/storage/migrate.js'
import { seed } from '../../src/storage/seed.js'
import { testModelBaseUrl } from './conversation-stream.js'
import { testMailUrl } from './mail.js'

export default async function prepareDatabase() {
  if (!process.env.DATABASE_URL) process.loadEnvFile('.env')
  const admin = new Pool({ connectionString: process.env.DATABASE_URL })
  const name = 'human_epochs_e2e_' + randomUUID().replaceAll('-', '')
  const url = new URL(process.env.DATABASE_URL!)
  url.pathname = '/' + name
  try { await admin.query('CREATE DATABASE ' + name) }
  catch (error) { await admin.end(); throw error }

  let server: ChildProcess | undefined
  const pool = new Pool({ connectionString: url.toString() })
  async function cleanup() {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, 'exit')
        server.kill('SIGTERM')
        await exited
      }
      await pool.end()
      await admin.query('DROP DATABASE ' + name)
    } finally { await admin.end() }
  }
  try {
    await migrate(pool)
    await seed(pool)
    process.env.DATABASE_URL = url.toString()
    // Keep the API lifetime inside that of its database, including setup failures and test interruptions.
    server = spawn(process.execPath, ['--import', 'tsx', 'src/app/server.ts'], {
      env: { ...process.env, PORT: '3307', HOST: '127.0.0.1', MODEL_API_KEY: '', AGENT_SETTINGS_ADMIN_EMAILS: 'alice@example.test',
        REGISTRATION_ENABLED: 'true',
        // Mail goes to a fake provider that recovery tests run on this port.
        MAIL_PROVIDER: 'resend', MAIL_API_URL: testMailUrl, MAIL_API_KEY: 'fixture-key', MAIL_FROM: 'test@example.test', PUBLIC_BASE_URL: 'http://127.0.0.1:5317',
        MODEL_ALLOWED_PRIVATE_BASE_URLS: testModelBaseUrl,
        MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const lines = createInterface({ input: server.stdout! })
    try {
      const [line] = await Promise.race([
        once(lines, 'line', { signal: AbortSignal.timeout(15000) }),
        once(server, 'exit').then(([code]) => { throw new Error('Test API exited before listening: ' + code) }),
      ])
      if (!String(line).startsWith('Human Epochs is listening at ')) throw new Error('Test API did not announce readiness')
    } finally { lines.close() }
    return cleanup
  } catch (error) {
    await cleanup()
    throw error
  }
}
