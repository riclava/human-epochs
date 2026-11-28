import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { MaterialPrompt } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const notes = { label: '气象笔记', text: '九点测得树荫下的气温为二十度，午后升到二十六度。' }

test('an export holds the user\'s own conversations, materials, memories, goals and reviews, and nothing internal', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(messages.at(-1)!.content!)
    const source = prompt.sources[0]!
    const quote = '九点测得树荫下的气温为二十度'
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'text', text: '上午九点是二十度。', citations: [{ sourceId: source.id, quote }] }],
      review: { topic: '上午气温', question: '九点的气温是多少？', answer: '二十度。', afterDays: 2, sourceId: source.id, quote },
    }) }
  })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const conversationId = randomUUID()
  const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
    payload: { conversationId, requestId: randomUUID(), messageText: '九点几度？', materialSelection: { excerpt: notes } } })
  const turn = await readConversationTurn(response.payload, String(response.headers['content-type']))
  await server.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie }, payload: {
    operation: 'remember', commandId: randomUUID(), kind: 'wish', body: '我想自己看懂天气。', topic: '', authorizedForTutoring: true, expiresAt: null } })
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'create', commandId: randomUUID(), title: '看懂天气图', motivation: '登山', progress: '', status: 'active' } })
  // Another user's data must not appear.
  const other = await login(server, 'bob@example.test')
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie: other }, payload: {
    operation: 'create', commandId: randomUUID(), title: '别人的目标', motivation: '', progress: '', status: 'active' } })

  const download = await server.inject({ url: '/api/account/export', headers: { cookie } })
  assert.equal(download.statusCode, 200)
  assert.match(String(download.headers['content-disposition']), /^attachment; filename="human-epochs-\d{4}-\d{2}-\d{2}\.json"$/)
  assert.equal(download.headers['cache-control'], 'private, no-store')
  const data = download.json()
  assert.deepEqual([data.format, data.version, data.account.email], ['human-epochs-export', 1, user.email])
  const [conversation] = data.conversations
  assert.equal(conversation.id, conversationId)
  assert.deepEqual(conversation.turns.map((item: { message: string; reply: string; sources: unknown }) => [item.message, item.reply, item.sources]),
    [['九点几度？', '上午九点是二十度。', [{ id: turn.materialContext!.sources[0]!.id, label: notes.label }]]])
  assert.deepEqual(data.materials.map((item: { label: string; text: string }) => [item.label, item.text]), [[notes.label, notes.text]])
  assert.deepEqual(data.memories.map((item: { body: string }) => item.body), ['我想自己看懂天气。'])
  assert.deepEqual(data.goals.map((item: { title: string }) => item.title), ['看懂天气图'])
  assert.deepEqual(data.reviews.map((item: { topic: string; answer: string; attempts: unknown[] }) => [item.topic, item.answer, item.attempts]), [['上午气温', '二十度。', []]])
  for (const secret of ['password', 'scrypt:', 'token', 'fingerprint', 'lease', '别人的目标']) {
    assert.ok(!download.payload.includes(secret), `the export does not include ${secret}`)
  }

  assert.equal((await server.inject({ url: '/api/account/export' })).statusCode, 401)
})
