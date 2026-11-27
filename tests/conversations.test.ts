import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationList, ConversationSnapshot } from '../src/contracts/conversation.js'
import type { ModelClient } from '../src/runtime/model.js'
import { publishedDiscussions } from '../src/courses/catalog.js'
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

test('a memory saved in one conversation helps a related question in another and is shown on the reply', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const inputs: string[] = []
  const server = createApp(pool, async ({ messages }) => {
    inputs.push(JSON.stringify(messages))
    return { kind: 'text', text: '好的。' }
  })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const api = client(server, cookie)
  const first = randomUUID()
  const source = await turnOf(await api.send(first, '我的雅思口语是最弱的一项。'))
  const saved = await server.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie }, payload: {
    operation: 'remember', commandId: randomUUID(), kind: 'statement', body: '我的雅思口语是最弱的一项。', topic: '雅思',
    authorizedForTutoring: true, expiresAt: null, sourceRequestId: source.requestId,
  } })
  assert.equal(saved.statusCode, 200, saved.payload)
  const memoryId = saved.json().memories[0].id

  const second = randomUUID()
  await turnOf(await api.send(second, '口语怎么练比较快？'))
  assert.ok(inputs.at(-1)!.includes('口语是最弱'), 'a related question uses the memory without naming its topic')
  const [reply] = (await api.snapshot(second)).turns
  assert.ok(reply?.kind === 'user')
  assert.deepEqual(reply.memoryIds, [memoryId])

  await turnOf(await api.send(second, '怎么批量重命名照片文件？'))
  assert.ok(!inputs.at(-1)!.includes('口语是最弱'), 'an unrelated question leaves the topical memory out')
})

test('a conversation can be renamed and deleted with replay-safe commands; confirmed records survive the delete', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, null)
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const api = client(server, cookie)
  const command = (conversationId: string, payload: object) =>
    server.inject({ method: 'POST', url: `/api/conversations/${conversationId}/commands`, headers: { cookie }, payload })
  const doomed = randomUUID()
  const kept = randomUUID()
  const discussion = publishedDiscussions[0]!
  const material = await turnOf(await api.send(doomed, discussion.question, { materialSelection: { discussionVersion: discussion.discussionVersion } }))
  const activity = await server.inject({ method: 'POST', url: `/api/conversation/${material.requestId}/activity`, headers: { cookie } })
  assert.equal(activity.statusCode, 200, activity.payload)
  const activityId = activity.json().activityId
  const note = await turnOf(await api.send(doomed, '我想先学会看星图。'))
  const saved = await server.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie }, payload: {
    operation: 'remember', commandId: randomUUID(), kind: 'wish', body: '我想先学会看星图。', topic: '星图',
    authorizedForTutoring: true, expiresAt: null, sourceRequestId: note.requestId,
  } })
  assert.equal(saved.statusCode, 200, saved.payload)
  await turnOf(await api.send(kept, '另一个对话'))

  const rename = { operation: 'rename', commandId: randomUUID(), title: '  星图入门  ' }
  const renamed = await command(doomed, rename)
  assert.equal(renamed.statusCode, 200, renamed.payload)
  assert.equal(renamed.json().conversations.find((item: { conversationId: string }) => item.conversationId === doomed).title, '星图入门')
  assert.deepEqual((await command(doomed, rename)).json(), (await api.list()), 'a replayed rename returns the current list')
  assert.equal((await command(doomed, { ...rename, title: '别的标题' })).statusCode, 409)
  assert.equal((await command(doomed, { ...rename, commandId: randomUUID(), title: ' ' })).statusCode, 400)
  assert.equal((await command(randomUUID(), { ...rename, commandId: randomUUID() })).statusCode, 404)
  const stranger = await login(server, 'bob@example.test')
  const foreign = await server.inject({ method: 'POST', url: `/api/conversations/${doomed}/commands`, headers: { cookie: stranger },
    payload: { operation: 'delete', commandId: randomUUID() } })
  assert.equal(foreign.statusCode, 404, 'another user cannot delete this conversation')

  const remove = { operation: 'delete', commandId: randomUUID() }
  const deleted = await command(doomed, remove)
  assert.equal(deleted.statusCode, 200, deleted.payload)
  assert.deepEqual(deleted.json().conversations.map((item: { conversationId: string }) => item.conversationId), [kept])
  assert.deepEqual((await command(doomed, remove)).json(), deleted.json(), 'a replayed delete returns the same list')
  assert.equal((await command(doomed, { ...remove, commandId: randomUUID() })).statusCode, 404)

  assert.equal((await server.inject({ url: '/api/conversations/' + doomed, headers: { cookie } })).statusCode, 410)
  assert.equal((await api.send(doomed, '还能发吗？')).statusCode, 410, 'a late send cannot recreate a deleted conversation')
  assert.equal((await pool.query('SELECT 1 FROM conversation_turns WHERE conversation_id = $1', [doomed])).rowCount, 0)

  const memories = (await server.inject({ url: '/api/personal-memories', headers: { cookie } })).json().memories
  assert.deepEqual(memories.map((item: { body: string; sourceRequestId: string | null }) => [item.body, item.sourceRequestId]),
    [['我想先学会看星图。', null]], 'a memory saved from the conversation stays, without its source')
  assert.equal((await server.inject({ url: '/api/activities/' + activityId, headers: { cookie } })).statusCode, 200,
    'an activity started from the discussion stays')
})
