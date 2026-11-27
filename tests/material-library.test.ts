import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot } from '../src/contracts/conversation.js'
import type { LearningRecord } from '../src/contracts/learning.js'
import type { MaterialLibrary } from '../src/contracts/material.js'
import type { MaterialPrompt } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { conversationCitations, readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const notes = { label: '离心机规程', text: '离心结束后等待转子完全停止再开盖取出样品。配平误差超过 0.1 克时重新配平。' }
const quote = '离心结束后等待转子完全停止再开盖取出样品。'

test('a material is stored once, chosen again in another conversation, and deleting it clears what it produced', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const prompts: MaterialPrompt[] = []
  const server = createApp(pool, async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(messages.at(-1)!.content!)
    prompts.push(prompt)
    const sourceId = prompt.sources[0]!.id
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'text', text: '要等转子停稳再开盖。', citations: [{ sourceId, quote }] }],
      review: { topic: '开盖时机', question: '什么时候可以开盖？', answer: '转子完全停止后。', afterDays: 2, sourceId, quote },
    }) }
  })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const send = (conversationId: string, materialSelection: object) => server.inject({ method: 'POST', url: '/api/conversation',
    headers: { cookie }, payload: { conversationId, requestId: randomUUID(), messageText: '什么时候可以开盖？', materialSelection } })
  const turnOf = async (response: Awaited<ReturnType<typeof send>>) => readConversationTurn(response.payload, String(response.headers['content-type']))
  const library = async (asCookie = cookie) => (await server.inject({ url: '/api/materials', headers: { cookie: asCookie } })).json<MaterialLibrary>()
  const command = (payload: object, asCookie = cookie) =>
    server.inject({ method: 'POST', url: '/api/materials/commands', headers: { cookie: asCookie }, payload })

  const first = randomUUID()
  const second = randomUUID()
  const a = await turnOf(await send(first, { excerpt: notes }))
  const b = await turnOf(await send(second, { excerpt: { ...notes, label: '另起的名字' } }))
  assert.equal(a.materialContext!.sources[0]!.id, b.materialContext!.sources[0]!.id, 'the same text reuses one material')
  let [material] = (await library()).materials
  assert.deepEqual({ label: material!.label, length: material!.length, conversations: material!.conversations },
    { label: notes.label, length: notes.text.length, conversations: 2 })
  assert.equal((await pool.query('SELECT 1 FROM materials WHERE user_id = $1', [user.id])).rowCount, 1)

  const third = randomUUID()
  const chosen = await turnOf(await send(third, { materialIds: [material!.id] }))
  assert.equal(chosen.explanationSource, 'model')
  assert.deepEqual(prompts.at(-1)!.sources.map(source => source.text), [notes.text], 'a chosen material is read without uploading it again')
  assert.deepEqual(conversationCitations(chosen.replyBlocks).map(citation => citation.quote), [quote])
  assert.equal((await send(randomUUID(), { materialIds: [randomUUID()] })).statusCode, 400)
  const other = await login(server, 'bob@example.test')
  assert.equal((await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: other },
    payload: { conversationId: randomUUID(), requestId: randomUUID(), messageText: '看看', materialSelection: { materialIds: [material!.id] } } })).statusCode,
  400, 'another user cannot read this material')
  assert.equal((await command({ operation: 'delete', materialId: material!.id }, other)).statusCode, 404)
  assert.ok((await pool.query('SELECT 1 FROM review_invitations WHERE user_id = $1', [user.id])).rowCount! > 0)

  const removed = await command({ operation: 'delete', materialId: material!.id })
  assert.equal(removed.statusCode, 200, removed.payload)
  assert.deepEqual(removed.json(), { materials: [] })
  assert.deepEqual((await command({ operation: 'delete', materialId: material!.id })).json(), { materials: [] }, 'deleting again changes nothing')
  const stored = await pool.query(`SELECT text, label, deleted_at IS NOT NULL AS deleted FROM materials WHERE user_id = $1`, [user.id])
  assert.deepEqual(stored.rows, [{ text: null, label: '', deleted: true }])
  const snapshots = await pool.query(`SELECT material_context::text AS context FROM conversation_turns WHERE user_id = $1`, [user.id])
  assert.ok(snapshots.rows.every(row => !row.context.includes('离心') && !row.context.includes(notes.label)), 'no snapshot keeps its name or words')

  const view = (await server.inject({ url: '/api/conversations/' + first, headers: { cookie } })).json<ConversationSnapshot>()
  const [turn] = view.turns
  assert.ok(turn?.kind === 'user')
  assert.deepEqual(turn.materialContext!.sources.map(source => [source.deleted, source.label, source.preview]), [[true, '已删除的材料', '']])
  assert.ok(turn.replyBlocks!.every(block => block.kind === 'unavailable'), 'replies written from the material are cleared')
  assert.equal(turn.messageText, '什么时候可以开盖？', 'the user\'s own message stays')
  assert.equal((await pool.query('SELECT 1 FROM review_invitations WHERE user_id = $1', [user.id])).rowCount, 0)
  assert.deepEqual((await server.inject({ url: '/api/learning-record', headers: { cookie } })).json<LearningRecord>().topics, [])
  assert.equal((await send(third, { parentRequestId: chosen.requestId })).statusCode, 400, 'a discussion with only deleted sources cannot continue')
  assert.equal((await send(randomUUID(), { materialIds: [material!.id] })).statusCode, 400, 'a deleted material cannot be chosen')

  const again = await turnOf(await send(randomUUID(), { excerpt: notes }))
  ;[material] = (await library()).materials
  assert.notEqual(again.materialContext!.sources[0]!.id, a.materialContext!.sources[0]!.id, 'attaching the text again makes a new material')
  assert.equal(material?.label, notes.label)
})
