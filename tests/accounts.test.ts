import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import { createRateLimit } from '../src/app/rate-limit.js'
import type { ConversationMaterialOption } from '../src/contracts/conversation.js'
import type { MaterialPrompt } from '../src/runtime/model.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const password = 'correct-horse-battery'

const cookieOf = (response: { headers: Record<string, unknown> }) => {
  const header = response.headers['set-cookie']
  return String(Array.isArray(header) ? header[0] : header).split(';')[0]!
}

// Quotes the opening of the first source, which every material reply can cite.
const citingModel = async ({ messages }: { messages: { content?: string | null }[] }) => {
  const prompt: MaterialPrompt = JSON.parse(messages.at(-1)!.content!)
  const source = prompt.sources[0]!
  const quote = source.text.slice(0, 12)
  return { kind: 'text' as const, text: JSON.stringify({
    blocks: [{ kind: 'text', text: '先看原文开头。', citations: [{ sourceId: source.id, quote }] }],
    review: { topic: '开头', question: '原文怎么开头？', answer: quote, afterDays: 2, sourceId: source.id, quote },
  }) }
}

test('registration follows the policy, signs the new account in, and refuses taken emails and floods', async t => {
  const closed = createApp(pool, null, undefined, undefined, { registration: { open: false } })
  t.after(() => closed.close())
  assert.deepEqual((await closed.inject({ url: '/api/registration' })).json(), { open: false })
  const email = `new-${randomUUID()}@Example.test`
  const body = { email, displayName: '  小林 ', password }
  assert.equal((await closed.inject({ method: 'POST', url: '/api/register', payload: body })).statusCode, 403)

  const server = createApp(pool, null, undefined, undefined, { registration: { open: true, perHour: 2 } })
  t.after(() => server.close())
  t.after(() => pool.query('DELETE FROM users WHERE email = $1', [email.toLowerCase()]))
  assert.equal((await server.inject({ method: 'POST', url: '/api/register', payload: { ...body, password: 'short' } })).statusCode, 400)
  const created = await server.inject({ method: 'POST', url: '/api/register', payload: body })
  assert.equal(created.statusCode, 201, created.payload)
  const session = (await server.inject({ url: '/api/session', headers: { cookie: cookieOf(created) } })).json()
  assert.deepEqual({ email: session.user.email, name: session.user.displayName }, { email: email.toLowerCase(), name: '小林' })
  const taken = await server.inject({ method: 'POST', url: '/api/register', payload: { ...body, email: email.toUpperCase() } })
  assert.equal(taken.statusCode, 409, 'an email is taken regardless of case')
  assert.equal((await server.inject({ method: 'POST', url: '/api/register', payload: body })).statusCode, 429, 'the third valid attempt in an hour is refused')
  const login = await server.inject({ method: 'POST', url: '/api/login', payload: { email, password } })
  assert.equal(login.statusCode, 200, 'the new account signs in with its password')
})

test('the rate limit forgets attempts after its window', () => {
  let now = 0
  const limit = createRateLimit({ limit: 2, windowMs: 1000, now: () => now })
  assert.deepEqual([limit.take('a'), limit.take('a'), limit.take('a'), limit.take('b')], [true, true, false, true])
  now = 1001
  assert.equal(limit.take('a'), true)
})

test('an account can be renamed, change its password, and be deleted with everything it owns', { timeout: 20_000 }, async t => {
  const server = createApp(pool, citingModel, undefined, undefined, { registration: { open: true } })
  t.after(() => server.close())
  const email = `owner-${randomUUID()}@example.test`
  t.after(() => pool.query('DELETE FROM users WHERE email = $1', [email]))
  const created = await server.inject({ method: 'POST', url: '/api/register', payload: { email, displayName: '小周', password } })
  const phone = cookieOf(created)
  const desktop = cookieOf(await server.inject({ method: 'POST', url: '/api/login', payload: { email, password } }))
  const command = (cookie: string, payload: object) => server.inject({ method: 'POST', url: '/api/account/commands', headers: { cookie }, payload })
  const signedIn = async (cookie: string) => (await server.inject({ url: '/api/session', headers: { cookie } })).statusCode === 200

  assert.equal((await command(phone, { operation: 'rename', displayName: '周老师' })).statusCode, 204)
  assert.equal((await server.inject({ url: '/api/session', headers: { cookie: desktop } })).json().user.displayName, '周老师')
  assert.equal((await command(phone, { operation: 'change_password', currentPassword: 'wrong-password', newPassword: 'another-password-1' })).statusCode, 403)
  assert.ok(await signedIn(desktop), 'a refused change signs nobody out')
  assert.equal((await command(phone, { operation: 'change_password', currentPassword: password, newPassword: 'another-password-1' })).statusCode, 204)
  assert.deepEqual([await signedIn(phone), await signedIn(desktop)], [true, false], 'other devices are signed out')
  assert.equal((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password } })).statusCode, 401)
  assert.equal((await server.inject({ method: 'POST', url: '/api/login', payload: { email, password: 'another-password-1' } })).statusCode, 200)

  // Leave something in every part of the account: a course discussion with an activity, an attached material with
  // a review, and a memory.
  const userId = (await server.inject({ url: '/api/session', headers: { cookie: phone } })).json().user.id as string
  const [course] = (await server.inject({ url: '/api/conversation/materials', headers: { cookie: phone } })).json().materials as ConversationMaterialOption[]
  const send = (materialSelection: object) => server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: phone },
    payload: { conversationId: randomUUID(), requestId: randomUUID(), messageText: '讲讲原文', materialSelection } })
  const turnOf = async (response: Awaited<ReturnType<typeof send>>) => readConversationTurn(response.payload, String(response.headers['content-type']))
  const discussed = await turnOf(await send({ discussionVersion: course!.discussionVersion }))
  const activity = await server.inject({ method: 'POST', url: `/api/conversation/${discussed.requestId}/activity`, headers: { cookie: phone } })
  assert.equal(activity.statusCode, 200, activity.payload)
  await turnOf(await send({ excerpt: { label: '笔记', text: '九点测得树荫下的气温为二十度，午后升到二十六度。' } }))
  const remembered = await server.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie: phone }, payload: {
    operation: 'remember', commandId: randomUUID(), kind: 'statement', body: '我在准备气象员考试。', topic: '', authorizedForTutoring: true, expiresAt: null,
  } })
  assert.equal(remembered.statusCode, 200, remembered.payload)

  const { rows: tables } = await pool.query<{ table: string }>(`
    SELECT table_name AS table FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY 1
  `)
  const owned = async () => {
    const counts: Record<string, number> = {}
    for (const { table } of tables) {
      const { rows: [row] } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId])
      if (row.n) counts[table] = row.n
    }
    return counts
  }
  const before = await owned()
  for (const table of ['activities', 'conversation_turns', 'discussion_activities', 'materials', 'personal_memories', 'review_invitations', 'sessions']) {
    assert.ok(before[table], `the account owns rows in ${table}`)
  }

  assert.equal((await command(phone, { operation: 'delete', password })).statusCode, 403, 'the old password cannot delete the account')
  const deleted = await command(phone, { operation: 'delete', password: 'another-password-1' })
  assert.equal(deleted.statusCode, 204, deleted.payload)
  assert.match(String(deleted.headers['set-cookie']), /he_session=;/)
  assert.deepEqual(await owned(), {}, 'nothing the account owned remains')
  assert.equal((await pool.query('SELECT 1 FROM users WHERE id = $1', [userId])).rowCount, 0)
  assert.equal(await signedIn(phone), false)
  const again = await server.inject({ method: 'POST', url: '/api/register', payload: { email, displayName: '小周', password } })
  assert.equal(again.statusCode, 201, 'the email can be registered again')
})
