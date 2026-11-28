import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { readServerConfig } from '../src/app/config.js'
import { createApp } from '../src/app/create-app.js'
import { createMailSender, type MailMessage } from '../src/app/mail.js'
import { useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const password = 'first-password-1'

const cookieOf = (response: { headers: Record<string, unknown> }) => String([response.headers['set-cookie']].flat()[0]).split(';')[0]!
const linkToken = (message: MailMessage | undefined, route: string) => {
  const match = new RegExp(`https://learn\\.example/#/${route}\\?token=([A-Za-z0-9_-]{43})`, 'u').exec(message?.text ?? '')
  assert.ok(match, `the mail links to ${route}`)
  return match[1]!
}

function appWithMail(failing = false) {
  const outbox: MailMessage[] = []
  const app = createApp(pool, null, undefined, undefined, { registration: { open: true }, mail: { baseUrl: 'https://learn.example', send: async message => {
    if (failing) throw new Error('provider down')
    outbox.push(message)
  } } })
  return { app, outbox }
}

test('a new account gets a verification link that works once', async t => {
  const { app, outbox } = appWithMail()
  t.after(() => app.close())
  const email = `verify-${randomUUID()}@example.test`
  t.after(() => pool.query('DELETE FROM users WHERE email = $1', [email]))
  const created = await app.inject({ method: 'POST', url: '/api/register', payload: { email, displayName: '小林', password } })
  const cookie = cookieOf(created)
  const session = async () => (await app.inject({ url: '/api/session', headers: { cookie } })).json().user
  assert.equal((await session()).emailVerified, false)
  assert.deepEqual([outbox.length, outbox[0]!.to, outbox[0]!.subject], [1, email, '确认你的 Human Epochs 邮箱'])

  const resent = await app.inject({ method: 'POST', url: '/api/email-verification', headers: { cookie } })
  assert.equal(resent.statusCode, 202)
  const stale = linkToken(outbox[0], 'verify-email')
  const token = linkToken(outbox[1], 'verify-email')
  const confirm = (value: string) => app.inject({ method: 'POST', url: '/api/email-verification/confirm', payload: { token: value } })
  assert.equal((await confirm(stale)).statusCode, 410, 'a newer mail replaces the older link')
  assert.equal((await confirm(token)).statusCode, 204, 'the link works without being signed in')
  assert.equal((await confirm(token)).statusCode, 410, 'and only once')
  assert.equal((await session()).emailVerified, true)
  assert.deepEqual((await app.inject({ method: 'POST', url: '/api/email-verification', headers: { cookie } })).json(), { status: 'verified' })
  assert.equal(outbox.length, 2, 'a verified address gets no more mail')
})

test('a reset link sets a new password once, signs out every device and never reveals whether an account exists', async t => {
  const { app, outbox } = appWithMail()
  t.after(() => app.close())
  const email = `reset-${randomUUID()}@example.test`
  t.after(() => pool.query('DELETE FROM users WHERE email = $1', [email]))
  const old = cookieOf(await app.inject({ method: 'POST', url: '/api/register', payload: { email, displayName: '小周', password } }))
  outbox.length = 0
  const ask = (address: string) => app.inject({ method: 'POST', url: '/api/password-reset', payload: { email: address } })
  const confirm = (token: string, next: string) => app.inject({ method: 'POST', url: '/api/password-reset/confirm', payload: { token, password: next } })

  assert.equal((await ask(`nobody-${randomUUID()}@example.test`)).statusCode, 202)
  assert.equal(outbox.length, 0, 'an unknown address answers the same and sends nothing')
  assert.equal((await ask(email.toUpperCase())).statusCode, 202)
  const first = linkToken(outbox[0], 'reset-password')
  await ask(email)
  const second = linkToken(outbox[1], 'reset-password')
  assert.equal((await confirm(first, 'second-password-2')).statusCode, 410, 'only the newest link works')
  assert.equal((await confirm(second, 'short')).statusCode, 400)

  const reset = await confirm(second, 'second-password-2')
  assert.equal(reset.statusCode, 204)
  const signedIn = await app.inject({ url: '/api/session', headers: { cookie: cookieOf(reset) } })
  assert.equal(signedIn.json().user.emailVerified, true, 'opening the link proves the address')
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: old } })).statusCode, 401, 'other devices are signed out')
  assert.equal((await confirm(second, 'third-password-3')).statusCode, 410, 'a link works once')
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'second-password-2' } })).statusCode, 200)

  await ask(email)
  const expired = linkToken(outbox.at(-1), 'reset-password')
  await pool.query(`UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`)
  assert.equal((await confirm(expired, 'third-password-3')).statusCode, 410, 'an expired link does nothing')
  await ask(email)
  const moved = linkToken(outbox.at(-1), 'reset-password')
  await pool.query('UPDATE users SET email = $2 WHERE email = $1', [email, 'moved-' + email])
  assert.equal((await confirm(moved, 'third-password-3')).statusCode, 410, 'a link is for the address it was sent to')
  await pool.query('UPDATE users SET email = $1 WHERE email = $2', [email, 'moved-' + email])

  for (let index = 0; index < 3; index++) await ask(email)
  const sent = outbox.length
  assert.equal((await ask(email)).statusCode, 202, 'a limited request still looks sent')
  assert.equal(outbox.length, sent, 'but sends nothing')
})

test('without mail the features are off, and a failed send does not block sign-up', async t => {
  const plain = createApp(pool, null, undefined, undefined, { registration: { open: true } })
  t.after(() => plain.close())
  assert.deepEqual((await plain.inject({ url: '/api/registration' })).json(), { open: true, passwordReset: false })
  assert.equal((await plain.inject({ method: 'POST', url: '/api/password-reset', payload: { email: 'alice@example.test' } })).statusCode, 503)
  const alice = await plain.inject({ method: 'POST', url: '/api/login', payload: { email: 'alice@example.test', password: 'HumanEpochs-demo-1!' } })
  assert.equal(alice.json().user.emailVerified, null, 'without mail there is nothing to verify')

  const { app } = appWithMail(true)
  t.after(() => app.close())
  const email = `down-${randomUUID()}@example.test`
  t.after(() => pool.query('DELETE FROM users WHERE email = $1', [email]))
  const created = await app.inject({ method: 'POST', url: '/api/register', payload: { email, displayName: '小吴', password } })
  assert.equal(created.statusCode, 201)
  assert.equal((await app.inject({ method: 'POST', url: '/api/email-verification', headers: { cookie: cookieOf(created) } })).statusCode, 502)
})

test('the HTTP mail sender posts one message and fails on an error answer; production refuses unsafe mail settings', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const reply = { ok: true }
  const send = createMailSender({ provider: 'resend', apiKey: 'key', from: 'Human Epochs <noreply@learn.example>', apiUrl: 'https://mail.example/emails' },
    async (url, init) => { calls.push({ url: String(url), init: init! }); return reply as Response })!
  await send({ to: 'a@example.test', subject: '主题', text: '正文' })
  assert.equal(calls[0]!.url, 'https://mail.example/emails')
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer key')
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { from: 'Human Epochs <noreply@learn.example>', to: ['a@example.test'], subject: '主题', text: '正文' })
  reply.ok = false
  await assert.rejects(send({ to: 'a@example.test', subject: '主题', text: '正文' }))

  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/db', MODEL_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), AGENT_SETTINGS_ADMIN_EMAILS: 'owner@learn.example' }
  assert.equal(readServerConfig(base).mail.provider, 'none', 'production sends no mail unless configured')
  assert.throws(() => readServerConfig({ ...base, MAIL_PROVIDER: 'log' }), /MAIL_PROVIDER=log/)
  assert.throws(() => readServerConfig({ ...base, MAIL_PROVIDER: 'resend' }), (error: Error) =>
    ['MAIL_API_KEY', 'MAIL_FROM', 'PUBLIC_BASE_URL'].every(name => error.message.includes(name)))
  const configured = readServerConfig({ ...base, MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'k', MAIL_FROM: 'x@learn.example', PUBLIC_BASE_URL: 'https://learn.example/' })
  assert.equal(configured.publicBaseUrl, 'https://learn.example')
  assert.equal(readServerConfig({ DATABASE_URL: 'postgresql://localhost/db' }).mail.provider, 'log', 'development writes mail to the log')
})
