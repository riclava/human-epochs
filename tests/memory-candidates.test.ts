import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import { processNextMemoryExtraction } from '../src/app/memory-extraction.js'
import { defaultAgentSettings } from '../src/contracts/agent-settings.js'
import type { ConversationSnapshot } from '../src/contracts/conversation.js'
import type { MemoryExtraction, PersonalMemorySnapshot } from '../src/contracts/personal-memory.js'
import type { ModelClient } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
type Server = ReturnType<typeof createApp>

async function send(server: Server, cookie: string, messageText: string) {
  const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
    payload: { requestId: randomUUID(), messageText } })
  assert.equal(response.statusCode, 200, response.payload)
  const turn = await readConversationTurn(response.payload, String(response.headers['content-type']))
  assert.equal(turn.status, 'complete')
  return turn
}

function extractor(reply: () => MemoryExtraction, inputs: string[] = []): ModelClient {
  return async ({ messages, format }) => {
    assert.equal(format, 'json')
    const content = messages[0]!.content!
    inputs.push(content)
    return { kind: 'text', text: JSON.stringify(reply()) }
  }
}

const candidate = (quote: string, body = quote) => ({ kind: 'wish' as const, body, quote, reason: '以后安排阅读计划时有用', topic: '史记', tutoring: true })

test('memory candidates are confirmed by their owner and follow the current source across devices', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, async () => ({ kind: 'text', text: '好的，我们从第一篇开始。' }))
  t.after(() => server.close())
  const desktop = await login(server, user.email)
  const phone = await login(server, user.email)
  const other = await login(server, 'bob@example.test')
  const change = (cookie: string, payload: object) => server.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie }, payload })
  const snapshot = async (cookie: string): Promise<ConversationSnapshot> =>
    (await server.inject({ url: '/api/conversation', headers: { cookie } })).json()
  const jobs = () => pool.query('SELECT status, attempt FROM personal_memory_extractions WHERE user_id = $1 ORDER BY status', [user.id])
  const resetJobs = () => pool.query(`UPDATE personal_memory_extractions SET status = 'pending', attempt = 0, lease_until = NULL WHERE user_id = $1`, [user.id])
  const config = (model: ModelClient) => async () => ({ model, settings: defaultAgentSettings })

  await send(server, desktop, '先不用记住这句话。')
  assert.equal((await jobs()).rowCount, 0, 'messages are only extracted after the owner opts in')

  const enable = { operation: 'set_suggestions', commandId: randomUUID(), enabled: true }
  const enabled = await change(desktop, enable)
  assert.equal(enabled.statusCode, 200, enabled.payload)
  assert.equal(enabled.json().suggestionsEnabled, true)
  assert.deepEqual((await change(phone, enable)).json(), enabled.json())
  assert.equal((await change(phone, { ...enable, enabled: false })).statusCode, 409)

  const plan = '我想在年底前读完《史记》，每天读二十分钟。'
  const first = await send(server, desktop, plan)
  assert.equal((await snapshot(phone)).suggestionsPending, true)
  const inputs: string[] = []
  const propose = extractor(() => ({ candidates: [candidate('每天读二十分钟'), candidate('并非原话的内容')] }), inputs)
  assert.equal(await processNextMemoryExtraction(pool, config(propose)), true)
  assert.equal(await processNextMemoryExtraction(pool, config(propose)), false)
  assert.deepEqual(JSON.parse(inputs[0]!), { message: plan, savedMemories: [] })

  const seen = await snapshot(phone)
  assert.equal(seen.suggestionsPending, false)
  assert.deepEqual(seen.candidates.map(({ quote, sourceRequestId }) => ({ quote, sourceRequestId })),
    [{ quote: '每天读二十分钟', sourceRequestId: first.requestId }], 'quotes must come from the source message')
  assert.deepEqual((await snapshot(other)).candidates, [])

  await resetJobs()
  assert.equal(await processNextMemoryExtraction(pool, config(extractor(() => ({ candidates: [candidate(' 每天读二十分钟 ', '换个说法')] })))), true)
  assert.equal((await snapshot(desktop)).candidates.length, 1, 'a rebuilt extraction does not duplicate a candidate')

  const [proposal] = seen.candidates
  assert.equal((await change(other, { operation: 'reject_candidate', commandId: randomUUID(), candidateId: proposal!.id })).statusCode, 404)
  const reject = { operation: 'reject_candidate', commandId: randomUUID(), candidateId: proposal!.id }
  const rejected = await change(phone, reject)
  assert.equal(rejected.statusCode, 200, rejected.payload)
  assert.deepEqual(rejected.json().candidates, [])
  assert.deepEqual((await change(desktop, reject)).json(), rejected.json())
  const stored = await pool.query('SELECT status, body, quote FROM personal_memory_candidates WHERE user_id = $1', [user.id])
  assert.deepEqual(stored.rows, [{ status: 'rejected', body: null, quote: null }])

  await resetJobs()
  assert.equal(await processNextMemoryExtraction(pool, config(propose)), true)
  assert.deepEqual((await snapshot(desktop)).candidates, [], 'a rejected candidate is not proposed again')

  // A forget or correction during generation discards the late result and the next attempt reads current memories.
  const remembered = { operation: 'remember', commandId: randomUUID(), kind: 'statement', body: '我在读《史记》',
    topic: '', authorizedForTutoring: false, expiresAt: null }
  assert.equal((await change(desktop, remembered)).statusCode, 200)
  const habit = '我喜欢先读白话译文，再对照原文。'
  const second = await send(server, desktop, habit)
  let started!: () => void
  let release!: () => void
  const claimed = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const habitModel = extractor(() => ({ candidates: [{ ...candidate('先读白话译文'), kind: 'statement' }] }))
  const late = processNextMemoryExtraction(pool, config(async input => { started(); await blocked; return habitModel(input) }))
  await claimed
  const corrected = await change(phone, { ...remembered, operation: 'correct', commandId: randomUUID(),
    id: remembered.commandId, expectedRevision: 1, body: '我在读《史记·本纪》' })
  assert.equal(corrected.statusCode, 200, corrected.payload)
  release()
  assert.equal(await late, true)
  assert.deepEqual((await snapshot(desktop)).candidates, [])
  assert.deepEqual((await pool.query(`
    SELECT status, attempt FROM personal_memory_extractions WHERE user_id = $1 AND source_request_id = $2
  `, [user.id, second.requestId])).rows, [{ status: 'pending', attempt: 1 }])
  assert.equal(await processNextMemoryExtraction(pool, config(habitModel)), true)
  const [habitCandidate] = (await snapshot(phone)).candidates
  assert.equal(habitCandidate?.sourceRequestId, second.requestId)

  const accept = { operation: 'accept_candidate', commandId: randomUUID(), candidateId: habitCandidate!.id,
    kind: 'statement', body: '我习惯先读白话译文', topic: '史记', authorizedForTutoring: true, expiresAt: null }
  assert.equal((await change(other, { ...accept, commandId: randomUUID() })).statusCode, 404)
  const accepted = await change(desktop, accept)
  assert.equal(accepted.statusCode, 200, accepted.payload)
  const acceptedView: PersonalMemorySnapshot = accepted.json()
  assert.deepEqual(acceptedView.candidates, [])
  assert.deepEqual(acceptedView.memories.find(memory => memory.id === habitCandidate!.id), {
    id: habitCandidate!.id, revision: 1, kind: 'statement', body: '我习惯先读白话译文', topic: '史记',
    authorizedForTutoring: true, expiresAt: null, sourceRequestId: second.requestId,
  })
  assert.deepEqual((await change(phone, accept)).json(), acceptedView)
  assert.equal((await change(phone, { ...accept, commandId: randomUUID() })).statusCode, 404)

  // Turning suggestions off clears unanswered candidates and fences a job that is still generating.
  const third = await send(server, desktop, '我打算每周写一篇读书笔记。')
  assert.equal(await processNextMemoryExtraction(pool, config(extractor(() => ({ candidates: [candidate('每周写一篇读书笔记')] })))), true)
  assert.equal((await snapshot(phone)).candidates[0]?.sourceRequestId, third.requestId)
  await send(server, desktop, '我更喜欢在早上读书。')
  let fenced!: () => void
  let resume!: () => void
  const generating = new Promise<void>(resolve => { fenced = resolve })
  const resumed = new Promise<void>(resolve => { resume = resolve })
  const disabled = processNextMemoryExtraction(pool, config(async input => {
    fenced(); await resumed
    return extractor(() => ({ candidates: [candidate('在早上读书')] }))(input)
  }))
  await generating
  const off = await change(phone, { operation: 'set_suggestions', commandId: randomUUID(), enabled: false })
  assert.equal(off.statusCode, 200, off.payload)
  resume()
  assert.equal(await disabled, true)
  const final = await snapshot(desktop)
  assert.equal(final.suggestionsEnabled, false)
  assert.deepEqual(final.candidates, [])
  assert.equal((await pool.query(`SELECT 1 FROM personal_memory_candidates WHERE user_id = $1 AND status = 'pending'`, [user.id])).rowCount, 0)
  assert.equal((await pool.query(`SELECT 1 FROM personal_memory_extractions WHERE user_id = $1 AND status = 'pending'`, [user.id])).rowCount, 0)
  await send(server, desktop, '关闭以后说的话。')
  assert.equal(await processNextMemoryExtraction(pool, config(propose)), false)
})

test('guided replies do not queue memory extraction', async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, null)
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const enable = await server.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie },
    payload: { operation: 'set_suggestions', commandId: randomUUID(), enabled: true } })
  assert.equal(enable.statusCode, 200, enable.payload)
  await send(server, cookie, '我想学会看星图。')
  assert.equal((await pool.query('SELECT 1 FROM personal_memory_extractions WHERE user_id = $1', [user.id])).rowCount, 0)
})
