import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readServerConfig } from '../src/app/config.js'
import { createApp } from '../src/app/create-app.js'
import { useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const key = Buffer.alloc(32, 7).toString('base64')
const database = 'postgresql://localhost/example'

test('production refuses demo administrators and a missing key, listing every problem', () => {
  assert.throws(() => readServerConfig({ NODE_ENV: 'production', DATABASE_URL: database, AGENT_SETTINGS_ADMIN_EMAILS: 'alice@example.test' }),
    (error: Error) => error.message.includes('MODEL_CREDENTIAL_ENCRYPTION_KEY') && error.message.includes('AGENT_SETTINGS_ADMIN_EMAILS'))
  assert.throws(() => readServerConfig({ PORT: '3001' }), /DATABASE_URL/)
  assert.throws(() => readServerConfig({ DATABASE_URL: database, TRUST_PROXY: 'maybe' }), /TRUST_PROXY/)
  const config = readServerConfig({ NODE_ENV: 'production', DATABASE_URL: database, MODEL_CREDENTIAL_ENCRYPTION_KEY: key,
    AGENT_SETTINGS_ADMIN_EMAILS: 'owner@school.example', TRUST_PROXY: '1', REGISTRATION_ENABLED: '', PORT: '8080' })
  assert.deepEqual([config.PORT, config.TRUST_PROXY, config.REGISTRATION_ENABLED, config.MIGRATE_ON_START], [8080, 1, false, false],
    'an empty value counts as unset')
  assert.equal(readServerConfig({ DATABASE_URL: database, AGENT_SETTINGS_ADMIN_EMAILS: 'alice@example.test' }).NODE_ENV, 'development',
    'development keeps the demo administrator')
})

test('failed sign-ins are limited per account and per address, and successful ones are not counted', async t => {
  const server = createApp(pool, null, undefined, undefined, { trustProxy: 1 })
  t.after(() => server.close())
  const signIn = (email: string, password: string, address: string) => server.inject({ method: 'POST', url: '/api/login',
    headers: { 'x-forwarded-for': address }, payload: { email, password } })
  for (let index = 0; index < 12; index++) assert.equal((await signIn('alice@example.test', 'HumanEpochs-demo-1!', '198.51.100.1')).statusCode, 200)

  const guesses = []
  for (let index = 0; index < 11; index++) guesses.push((await signIn('alice@example.test', 'wrong-' + index, '198.51.100.' + (index + 2))).statusCode)
  assert.deepEqual(guesses, [...Array(10).fill(401), 429], 'ten wrong passwords lock the account for a while, from any address')
  assert.equal((await signIn('alice@example.test', 'HumanEpochs-demo-1!', '198.51.100.50')).statusCode, 429)
  assert.equal((await signIn('bob@example.test', 'HumanEpochs-demo-1!', '198.51.100.50')).statusCode, 200, 'other accounts are unaffected')

  const sprayed = []
  for (let index = 0; index < 31; index++) sprayed.push((await signIn(`nobody${index}@example.test`, 'guess', '203.0.113.7')).statusCode)
  assert.deepEqual(sprayed.slice(-2), [401, 429], 'one address may fail thirty times')
  assert.equal((await signIn('bob@example.test', 'HumanEpochs-demo-1!', '203.0.113.7')).statusCode, 429)
  assert.equal((await signIn('bob@example.test', 'HumanEpochs-demo-1!', '203.0.113.8')).statusCode, 200, 'the forwarded address is trusted')
})

test('responses carry security headers and the health checks report the database', async t => {
  const server = createApp(pool, null, undefined, undefined, { production: true })
  t.after(() => server.close())
  const health = await server.inject({ url: '/api/healthz' })
  assert.deepEqual([health.statusCode, health.json()], [200, { status: 'ok' }])
  assert.equal(health.headers['x-content-type-options'], 'nosniff')
  assert.equal(health.headers['x-frame-options'], 'DENY')
  assert.equal(health.headers['strict-transport-security'], 'max-age=31536000')
  assert.equal(health.headers['content-security-policy'], undefined, 'only pages carry the content policy')
  assert.equal((await server.inject({ url: '/api/readyz' })).statusCode, 200)

  const down = createApp({ query: async () => { throw new Error('connection refused') } } as never, null)
  t.after(() => down.close())
  assert.deepEqual([(await down.inject({ url: '/api/healthz' })).statusCode, (await down.inject({ url: '/api/readyz' })).statusCode], [200, 503])
})
