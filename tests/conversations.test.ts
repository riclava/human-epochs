import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationList, ConversationSnapshot } from '../src/contracts/conversation.js'
import type { ModelClient } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()

function client(server: ReturnType<typeof createApp>, cookie: string) {
  return {
    send: (conversationId: string, messageText: string, extra: object = {}) => server.inject({
      method: 'POST', url: '/api/conversation', headers: { cookie },
      payload: { conversationId, requestId: randomUUID(), messageText, ...extra },
    }),
    snapshot: async (conversationId: string) =>
      (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>(),
    list: async () => (await server.inject({ url: '/api/conversations', headers: { cookie } })).json<ConversationList>(),
  }
}
const turnOf = (response: { payload: string; headers: Record<string, unknown> }) =>
  readConversationTurn(response.payload, String(response.headers['content-type']))

test('conversations keep their own turns, history and title, and list by recent use', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const histories: string[] = []
  const model: ModelClient = async ({ messages }) => {
    histories.push(JSON.stringify(messages))
    return { kind: 'text', text: '收到。' }
  }
  const server = createApp(pool, model)
  t.after(() => server.close())
  const desktop = client(server, await login(server, user.email))
  const phone = client(server, await login(server, user.email))
  const stars = randomUUID()
  const python = randomUUID()

  const fresh = await desktop.snapshot(stars)
  assert.deepEqual({ id: fresh.conversationId, title: fresh.title, turns: fresh.turns }, { id: stars, title: null, turns: [] })
  assert.deepEqual((await desktop.list()).conversations, [], 'opening a new conversation does not create it')

  await turnOf(await desktop.send(stars, '我想学会   看星图，\n从哪里开始？'))
  await turnOf(await desktop.send(python, '怎么用 Python 读取 CSV 文件？'))
  await turnOf(await phone.send(stars, '北斗七星在哪个方向？'))
  assert.ok(histories.at(-1)!.includes('看星图'), 'a conversation reads its own history')
  assert.ok(!histories.at(-1)!.includes('CSV'), 'another conversation stays out of the history')

  const listed = (await phone.list()).conversations
  assert.deepEqual(listed.map(item => [item.conversationId, item.title]),
    [[stars, '我想学会 看星图， 从哪里开始？'], [python, '怎么用 Python 读取 CSV 文件？']])
  const starView = await phone.snapshot(stars)
  assert.equal(starView.title, '我想学会 看星图， 从哪里开始？')
  assert.deepEqual(starView.turns.map(turn => turn.kind === 'user' && turn.messageText), ['我想学会   看星图，\n从哪里开始？', '北斗七星在哪个方向？'])
  assert.equal((await desktop.snapshot(python)).turns.length, 1)

  const other = client(server, await login(server, 'bob@example.test'))
  const leaked = await other.snapshot(stars)
  assert.deepEqual({ title: leaked.title, turns: leaked.turns }, { title: null, turns: [] }, 'another user reads only their own conversation')
  assert.ok(!(await other.list()).conversations.some(item => item.conversationId === stars))

  const long = randomUUID()
  await turnOf(await desktop.send(long, '甲'.repeat(60)))
  assert.equal((await desktop.snapshot(long)).title, '甲'.repeat(39) + '…')
  assert.equal((await server.inject({ url: '/api/conversations/not-an-id', headers: { cookie: await login(server, user.email) } })).statusCode, 404)
})

test('each conversation has its own reply in progress, and requests stay in their conversation', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const holding = new Promise<void>(resolve => { started = resolve })
  const server = createApp(pool, async ({ messages }) => {
    if (JSON.stringify(messages).includes('慢一点')) { started(); await held }
    return { kind: 'text', text: '好的。' }
  })
  t.after(() => { release(); return server.close() })
  const cookie = await login(server, user.email)
  const api = client(server, cookie)
  const first = randomUUID()
  const second = randomUUID()

  const slow = api.send(first, '慢一点回答')
  await holding
  assert.equal((await api.send(first, '再问一句')).statusCode, 409, 'one reply at a time inside a conversation')
  assert.equal((await turnOf(await api.send(second, '另一个对话'))).status, 'complete', 'other conversations are not blocked')
  release()
  assert.equal((await turnOf(await slow)).status, 'complete')

  const requestId = randomUUID()
  const payload = { requestId, messageText: '同一个请求' }
  const sent = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { ...payload, conversationId: first } })
  assert.equal((await turnOf(sent)).status, 'complete')
  const moved = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { ...payload, conversationId: second } })
  assert.equal(moved.statusCode, 409, 'a saved request cannot be replayed into another conversation')
})

test('a material follow-up continues only a discussion in the same conversation', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, null)
  t.after(() => server.close())
  const api = client(server, await login(server, user.email))
  const home = randomUUID()
  const rootId = randomUUID()
  const excerpt = { label: '记录', text: '馆藏在周一登记。' }
  const root = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: await login(server, user.email) },
    payload: { conversationId: home, requestId: rootId, messageText: '看看记录', materialSelection: { excerpt } } })
  assert.equal((await turnOf(root)).status, 'complete')

  assert.equal((await turnOf(await api.send(home, '接着说', { materialSelection: { parentRequestId: rootId } }))).status, 'complete')
  assert.equal((await api.send(randomUUID(), '接着说', { materialSelection: { parentRequestId: rootId } })).statusCode, 400)
})
