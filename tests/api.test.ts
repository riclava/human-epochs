import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Writable } from 'node:stream'
import { Pool } from 'pg'
import { createApp } from '../src/app/create-app.js'
import { processNextSummary } from '../src/app/memory/summaries.js'
import { createChatCompletionsModel } from '../src/models/chat-completions.js'
import { createModelProvider } from '../src/models/connections.js'
import { requestPublicModel } from '../src/models/public-model-request.js'
import { createModelCredentialCipher } from '../src/storage/model-credential.js'
import { migrate } from '../src/storage/migrate.js'
import { seed } from '../src/storage/seed.js'
import { ActivityViewSchema } from '../src/contracts/learning.js'
import { agentSettingsViewSchema, defaultAgentSettings, deepSeekOutputLimit, type AgentSettingsSnapshot, type SaveAgentSettingsRequest } from '../src/contracts/agent-settings.js'
import { chatContentText, type ChatMaterialInput, type ChatMaterialOption, type ChatTurn } from '../src/contracts/chat.js'
import { readServerEvents } from '../src/contracts/event-stream.js'
import { createTestActivity, createTestLearner, removeTestActivity, removeTestLearner } from './fixtures/activity.js'
import { chatCitations, modelChunk, readChatTurn } from './fixtures/chat-stream.js'
import { memoirCourse } from '../src/curriculum/catalog.js'
import { inTransaction } from '../src/storage/transaction.js'
import { createActivity } from '../src/activities/activities.js'
import type { MaterialPrompt, ModelMessage, StudyModel } from '../src/runtime/model.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Set DATABASE_URL before running database tests')
const admin = new Pool({ connectionString: databaseUrl })
const databaseName = 'human_epochs_test_' + randomUUID().replaceAll('-', '')
const testUrl = new URL(databaseUrl)
testUrl.pathname = '/' + databaseName
const pool = new Pool({ connectionString: testUrl.toString() })
let app: Awaited<ReturnType<typeof createApp>>
let created = false

before(async () => {
  await admin.query('CREATE DATABASE "' + databaseName + '"')
  created = true
  await migrate(pool)
  await seed(pool)
  app = await createApp(pool, null)
  await app.ready()
})

after(async () => {
  if (app) await app.close()
  await pool.end()
  if (created) await admin.query('DROP DATABASE "' + databaseName + '"')
  await admin.end()
})

async function login(email = 'alice@example.test') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { email, password: 'HumanEpochs-demo-1!' },
  })
  assert.equal(response.statusCode, 200)
  const header = response.headers['set-cookie']
  assert.equal(typeof header, 'string')
  assert.match(header as string, /HttpOnly/i)
  assert.match(header as string, /SameSite=Lax/i)
  return (header as string).split(';')[0]
}

test('only configured administrators can save versioned runtime settings and an active attempt keeps its settings', async t => {
  const account = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, account.id))
  const owner = await login()
  const learner = await login(account.email)
  const sourceText = '设备在 09:05 完成校准。'
  const requestId = randomUUID()
  const sourceId = 'excerpt:' + requestId
  let notifyModel!: () => void
  let finishToolCall!: () => void
  const modelStarted = new Promise<void>(resolve => { notifyModel = resolve })
  const updated = new Promise<void>(resolve => { finishToolCall = resolve })
  const calls: { tokens: number; toolChoice?: string }[] = []
  const server = createApp(pool, async ({ toolChoice, format, tools, maxOutputTokens }) => {
    calls.push({ tokens: maxOutputTokens, toolChoice })
    if (format === 'text') return { kind: 'text', text: '下一次请求已使用新设置。' }
    if (calls.length === 1) {
      assert.equal(tools?.[0].name, 'read_source')
      notifyModel()
      await updated
      return { kind: 'tool_calls', text: null, calls: [{ id: 'read', name: 'read_source', arguments: JSON.stringify({ sourceId }) }] }
    }
    return {
      kind: 'text',
      text: JSON.stringify({ blocks: [{ kind: 'text', text: '校准在 09:05 完成。', citations: [{ id: sourceId, quote: sourceText }] }] }),
    }
  }, ' Alice@EXAMPLE.TEST ')
  t.after(async () => {
    finishToolCall()
    await server.close()
    await pool.query('DELETE FROM agent_settings')
  })

  const url = '/api/agent-settings'
  const read = (cookie?: string) => server.inject({ url, headers: cookie ? { cookie } : {} })
  const save = (cookie: string, payload: AgentSettingsSnapshot) => server.inject({ method: 'PUT', url, headers: { cookie }, payload })
  assert.equal((await read()).statusCode, 401)
  assert.equal((await read(learner)).statusCode, 403)
  const { revision, settings, assistantAvailable } = agentSettingsViewSchema.parse((await read(owner)).json())
  assert.equal(assistantAvailable, true)
  const initial = { revision, settings }
  assert.deepEqual(initial, { revision: 0, settings: defaultAgentSettings })
  assert.equal((await save(learner, initial)).statusCode, 403)
  assert.equal((await save(owner, { ...initial, settings: { ...initial.settings, historyBytes: 100 } })).statusCode, 400)
  const proposed = { ...initial, settings: { ...initial.settings, maxOutputTokens: 3_072, inlineSourceChars: 500, maxModelCalls: 2 } }
  const outcomes = await Promise.all([save(owner, proposed), save(owner, proposed)])
  assert.deepEqual(outcomes.map(result => result.statusCode).sort(), [200, 409])
  const published = agentSettingsViewSchema.parse(outcomes.find(result => result.statusCode === 200)!.json())
  const saved = { revision: published.revision, settings: published.settings }
  assert.deepEqual(saved, { ...proposed, revision: 1 })

  const received = server.inject({ method: 'POST', url: '/api/chat', headers: { cookie: learner }, payload: {
    requestId, text: '设备什么时候完成校准？',
    material: { excerpt: { label: '设备记录', text: sourceText + '背景'.repeat(300) } },
  } })
  await Promise.race([modelStarted, received.then(response => assert.fail(`Expected a tool call before posting status ${response.statusCode}`))])
  try {
    const result = await save(owner, { ...saved, settings: { ...saved.settings, maxOutputTokens: 4_096, maxModelCalls: 5 } })
    assert.equal(result.statusCode, 200)
  } finally {
    finishToolCall()
  }
  const completed = await received
  assert.equal(completed.statusCode, 200)
  assert.equal((await terminalTurn(completed)).explanationMode, 'model')
  assert.equal((await sendChat(server, learner, randomUUID(), '可以问个新问题吗？')).statusCode, 200)
  assert.deepEqual(calls, [
    { tokens: 3_072, toolChoice: undefined },
    { tokens: 3_072, toolChoice: 'none' },
    { tokens: 4_096, toolChoice: undefined },
  ])
})

test('the model form stores a write-only key bound to its URL and the settings assistant cannot edit credentials', async t => {
  const account = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, account.id))
  const owner = await login()
  const learner = await login(account.email)
  const connection = { baseUrl: 'https://api.openai.com/v1', modelId: 'team/large' }
  const changes = { modelId: connection.modelId, maxOutputTokens: 4_096 }
  const calls: { endpoint: string; key: string | null; model: string; limit: number }[] = []
  let advice: { reply: string; changes: object } = { reply: '可以调整模型 ID 和输出上限。', changes }
  const fetchImpl: typeof fetch = async (url, options) => {
    const body = JSON.parse(String(options?.body))
    assert.equal(options?.redirect, 'error')
    calls.push({ endpoint: String(url), key: new Headers(options?.headers).get('Authorization'), model: body.model,
      limit: body.max_completion_tokens ?? body.max_tokens })
    if (body.response_format) {
      assert.ok(!String(options?.body).includes('test-key'))
      assert.equal(body.tools, undefined)
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(advice) } }] })
    }
    assert.equal(body.stream, true)
    return new Response(modelChunk('按步骤练习。', 'stop') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  const provider = createModelProvider({ STUDY_AGENT_API_KEY: 'default-test-key' }, fetchImpl, fetchImpl)
  const cipher = createModelCredentialCipher(Buffer.alloc(32, 1).toString('base64'))!
  const server = createApp(pool, null, 'alice@example.test', { provider, cipher })
  t.after(async () => {
    await server.close()
    await pool.query('DELETE FROM agent_settings')
  })

  const url = '/api/agent-settings'
  const read = async () => agentSettingsViewSchema.parse((await server.inject({ url, headers: { cookie: owner } })).json())
  const ask = (cookie: string) => server.inject({ method: 'POST', url: url + '/assistant', headers: { cookie },
    payload: { history: [{ role: 'user', content: '帮我切换到另一个连接。' }] } })
  const initial = await read()
  assert.equal(initial.settings.maxOutputTokens, deepSeekOutputLimit)
  assert.deepEqual(initial.connection, { baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-flash', hasApiKey: true })
  assert.equal((await ask(learner)).statusCode, 403)
  const result = await ask(owner)
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json(), advice)
  assert.deepEqual(await read(), initial)
  advice = { ...advice, changes: { apiKey: 'injected-key', baseUrl: 'https://elsewhere.example.test' } }
  assert.equal((await ask(owner)).statusCode, 502)
  assert.deepEqual(await read(), initial)

  const save = (command: SaveAgentSettingsRequest, cookie = owner) => server.inject({ method: 'PUT', url, headers: { cookie }, payload: command })
  const command = { revision: initial.revision, settings: { ...initial.settings, maxOutputTokens: 4_096 }, connection }
  const denied = await save(command)
  assert.equal(denied.statusCode, 400)
  assert.equal(denied.json().field, 'apiKey')
  const blocked = await save({ ...command, connection: { ...connection, baseUrl: 'https://127.0.0.1:8443', apiKey: 'test-key' } })
  assert.equal(blocked.statusCode, 400)
  assert.equal(blocked.json().field, 'baseUrl')
  await assert.rejects(requestPublicModel('https://[::ffff:127.0.0.1]/v1/chat/completions'))
  assert.equal((await sendChat(server, learner, randomUUID(), '请帮我制定练习步骤。')).statusCode, 200)
  const keyed = { ...command, connection: { ...connection, apiKey: 'alternate-test-key' } }
  assert.equal((await save(keyed, learner)).statusCode, 403)
  const saved = await save(keyed)
  assert.equal(saved.statusCode, 200)
  assert.ok(!saved.payload.includes('alternate-test-key'))
  assert.deepEqual((await read()).connection, { ...connection, hasApiKey: true })
  const { rows: [{ settings: persisted }] } = await pool.query('SELECT settings FROM agent_settings')
  assert.ok(!JSON.stringify(persisted).includes('alternate-test-key'))
  assert.throws(() => cipher.open(persisted.sealedApiKey, 'https://other.example.test'))
  assert.equal(cipher.open(persisted.sealedApiKey, connection.baseUrl), 'alternate-test-key')
  assert.equal((await save({ ...command, revision: 1, connection: { ...connection, modelId: 'team/small' } })).statusCode, 200)
  assert.equal((await sendChat(server, learner, randomUUID(), '接下来应该做什么？')).statusCode, 200)
  assert.deepEqual(calls, [
    { endpoint: 'https://api.deepseek.com/chat/completions', key: 'Bearer default-test-key', model: 'deepseek-flash', limit: 2_048 },
    { endpoint: 'https://api.deepseek.com/chat/completions', key: 'Bearer default-test-key', model: 'deepseek-flash', limit: 2_048 },
    { endpoint: 'https://api.deepseek.com/chat/completions', key: 'Bearer default-test-key', model: 'deepseek-flash', limit: deepSeekOutputLimit },
    { endpoint: 'https://api.openai.com/v1/chat/completions', key: 'Bearer alternate-test-key', model: 'team/small', limit: 4_096 },
  ])
})

async function activity(cookie: string) {
  const listing = await app.inject({ url: '/api/activities', headers: { cookie } })
  assert.equal(listing.statusCode, 200)
  const id = listing.json().activities.find((item: { title: string }) => item.title === memoirCourse.publicContent.title).activityId as string
  const response = await app.inject({ url: '/api/activities/' + id, headers: { cookie } })
  assert.equal(response.statusCode, 200)
  return ActivityViewSchema.parse(response.json())
}

test('independent sessions restore one database activity after app recreation', async () => {
  const firstCookie = await login()
  const secondCookie = await login()
  assert.notEqual(firstCookie, secondCookie)
  const first = await activity(firstCookie)
  assert.deepEqual(await activity(secondCookie), first)
  await app.close()
  app = await createApp(pool, null)
  assert.deepEqual(await activity(firstCookie), first)
  assert.equal(first.activityVersion, memoirCourse.version)
  assert.deepEqual(first.allowedActions, ['view', 'requestHint'])
})

test('hidden content stays server-side and cross-learner access is denied', async () => {
  const alice = await login()
  const bob = await login('bob@example.test')
  const first = await activity(alice)
  assert.notEqual((await activity(bob)).activityId, first.activityId)
  const path = '/api/activities/' + first.activityId
  assert.equal((await app.inject({ url: path })).statusCode, 401)
  assert.equal((await app.inject({ url: path, headers: { cookie: bob } })).statusCode, 404)
  assert.equal((await app.inject({ url: path + '/hints', headers: { cookie: alice } })).statusCode, 404)
  assert.deepEqual(first.hints, [])
  assert.equal(JSON.stringify(first).includes(memoirCourse.privateContent.hints[0]!), false)
  const escalation = await app.inject({
    url: path + '?include=unpublishedHints',
    headers: { cookie: alice },
  })
  assert.equal(escalation.statusCode, 200)
  assert.deepEqual(escalation.json(), first)
})

test('login verifies credentials; logout and expiry revoke session access', async () => {
  const invalid = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { email: 'alice@example.test', password: 'incorrect' },
  })
  assert.equal(invalid.statusCode, 401)
  const cookie = await login()
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie } })).statusCode, 200)
  const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
  assert.ok([200, 204].includes(logout.statusCode))
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie } })).statusCode, 401)
  const expiring = await login()
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 hour'")
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: expiring } })).statusCode, 401)
})

test('migrations and course seeding can run again without replacing progress', async () => {
  const cookie = await login()
  const initial = await activity(cookie)
  const received = await app.inject({
    method: 'POST', url: '/api/activities/' + initial.activityId + '/hints', headers: { cookie },
    payload: { activityId: initial.activityId, revision: initial.revision, commandId: randomUUID() },
  })
  assert.equal(received.statusCode, 200, received.payload)
  const original = await activity(cookie)
  assert.deepEqual(original.hints, memoirCourse.privateContent.hints.slice(0, 1))
  await migrate(pool)
  await seed(pool)
  assert.deepEqual(await activity(cookie), original)
  assert.equal((await pool.query('SELECT * FROM learners')).rowCount, 2)
  assert.equal((await pool.query('SELECT id FROM activities')).rowCount, 2)
  assert.deepEqual((await pool.query('SELECT version FROM curriculum_versions')).rows, [{ version: memoirCourse.version }])
})

function sendChat(server: typeof app, cookie: string, requestId: string, text: string) {
  return server.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { requestId, text } })
}

function terminalTurn(response: Awaited<ReturnType<typeof sendChat>>) {
  assert.equal(response.statusCode, 200, response.payload)
  return readChatTurn(response.payload, String(response.headers['content-type']))
}

async function readChat(server: typeof app, cookie: string): Promise<ChatTurn[]> {
  const response = await server.inject({ url: '/api/chat', headers: { cookie } })
  assert.equal(response.statusCode, 200)
  assert.ok(['guided', 'model'].includes(response.json().mode))
  return response.json().turns
}

function captureLogs() {
  const lines: string[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
  return { logger: { stream }, raw: () => lines.join(''), records: () => lines.join('').trim().split('\n').map(line => JSON.parse(line)) }
}

test('chat saves the question before generation, orders follow-ups and isolates learners', async t => {
  const alice = await login()
  const secondDevice = await login()
  const bob = await login('bob@example.test')
  const exercise = await activity(alice)
  const requestId = randomUUID()
  const question = '我猜作者只亲眼看到一盏灯。'
  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  let finishFirst!: (answer: string) => void
  const delayedAnswer = new Promise<string>(resolve => { finishFirst = resolve })
  const histories: ModelMessage[][] = []
  const server = createApp(pool, async ({ messages }) => {
    histories.push(messages)
    if (histories.length === 1) {
      notifyStarted()
      return { kind: 'text', text: await delayedAnswer }
    }
    return { kind: 'text', text: '我们可以先试一个小例子。' }
  })
  t.after(() => server.close())
  assert.equal((await server.inject({ url: '/api/chat' })).statusCode, 401)
  assert.equal((await server.inject({
    method: 'POST', url: '/api/chat', headers: { cookie: alice, 'x-learner-id': randomUUID() },
    payload: { requestId, text: question },
  })).statusCode, 401)
  for (const invalid of ['   ', 'x'.repeat(4001), 'bad\u0000text']) {
    assert.equal((await sendChat(server, alice, requestId, invalid)).statusCode, 400)
  }
  const generating = sendChat(server, alice, requestId, question)
  await started
  const pending = { requestId, text: question, content: null, status: 'pending' }
  assert.deepEqual(await readChat(server, secondDevice), [pending])
  assert.deepEqual(await readChat(server, bob), [])
  assert.deepEqual(await terminalTurn(await sendChat(server, alice, requestId, question)), pending)
  assert.equal((await sendChat(server, alice, requestId, 'changed')).statusCode, 409)
  assert.equal((await sendChat(server, secondDevice, randomUUID(), '新的问题')).statusCode, 409)
  const bobTurn = await sendChat(server, bob, requestId, '我想读图表')
  assert.equal(bobTurn.statusCode, 200)
  assert.deepEqual(histories[1], [{ role: 'user', content: '我想读图表' }])
  finishFirst('你想讨论按钮，还是服务端的写入规则？')
  const result = await generating
  assert.equal(result.statusCode, 200)
  const turn = await terminalTurn(result)
  const replay = await sendChat(server, secondDevice, requestId, question)
  assert.deepEqual(await terminalTurn(replay), turn)
  assert.equal(histories.length, 2)
  const followup = await sendChat(server, secondDevice, randomUUID(), '先看写入规则')
  assert.equal(followup.statusCode, 200)
  assert.deepEqual(histories[2], [
    { role: 'user', content: question },
    { role: 'assistant', content: chatContentText(turn.content) },
    { role: 'user', content: '先看写入规则' },
  ])
  // The other app instance uses the same database, as after a process restart.
  assert.deepEqual(await readChat(app, alice), [turn, await terminalTurn(followup)])
  assert.deepEqual(await activity(secondDevice), exercise)
})

test('generation can retry a persisted turn and a late attempt cannot overwrite its answer', async t => {
  const alice = await login()
  const requestId = randomUUID()
  const question = '为什么月相会变化？'
  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  let finishLate!: (answer: string) => void
  const lateAnswer = new Promise<string>(resolve => { finishLate = resolve })
  let calls = 0
  const server = createApp(pool, async () => {
    calls++
    if (calls === 1) throw Error('temporary provider failure')
    if (calls === 2) { notifyStarted(); return { kind: 'text', text: await lateAnswer } }
    return { kind: 'text', text: '先画出太阳、地球和月亮的位置。' }
  })
  t.after(() => server.close())
  const failed = await terminalTurn(await sendChat(server, alice, requestId, question))
  assert.equal(failed.status, 'retryable')
  assert.equal((await readChat(app, alice)).at(-1)?.status, 'retryable')
  const retry = sendChat(server, alice, requestId, question)
  await started
  await pool.query("UPDATE chat_turns SET lease_until = now() - interval '1 second' WHERE request_id = $1", [requestId])
  assert.equal((await readChat(server, alice)).at(-1)?.status, 'retryable')
  const recovered = await terminalTurn(await sendChat(server, alice, requestId, question))
  assert.equal(recovered.status, 'complete')
  finishLate('过时的回复')
  assert.deepEqual(await terminalTurn(await retry), recovered)
  assert.equal(calls, 3)
  assert.deepEqual((await readChat(server, alice)).filter(turn => turn.requestId === requestId), [recovered])
})

test('a new topic closes a failed attempt and repeated retries have a shared limit', async t => {
  const bob = await login('bob@example.test')
  const requestId = randomUUID()
  const nextId = randomUUID()
  let calls = 0
  const server = createApp(pool, async () => { calls++; throw Error('offline') })
  t.after(() => server.close())
  const first = () => sendChat(server, bob, requestId, '甲').then(terminalTurn)
  const next = () => sendChat(server, bob, nextId, '乙').then(terminalTurn)
  assert.equal((await first()).status, 'retryable')
  assert.equal((await next()).status, 'retryable')
  assert.equal((await first()).status, 'failed')
  assert.equal(calls, 2)
  assert.equal((await next()).status, 'retryable')
  assert.equal((await next()).status, 'failed')
  assert.equal((await next()).status, 'failed')
  assert.equal(calls, 4)
})

test('another session can stop a request, abort its model and read the durable result', { timeout: 5000 }, async t => {
  const learner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, learner.id))
  const desktop = await login(learner.email)
  const phone = await login(learner.email)
  const other = await login('bob@example.test')
  const requestId = randomUUID()
  const question = 'private fixture question about lunar eclipses'
  const logs = captureLogs()
  let signal!: AbortSignal
  let notifyStarted!: () => void
  const started = new Promise<void>(resolve => { notifyStarted = resolve })
  let finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  let calls = 0
  const server = createApp(pool, async input => {
    if (++calls === 1) {
      signal = input.signal
      input.onTextDelta?.('preview to discard')
      notifyStarted()
      await completion
    }
    return { kind: 'text', text: 'private fixture response', usage: { inputTokens: 20, outputTokens: 6 } }
  }, undefined, undefined, { logger: logs.logger })
  t.after(async () => { finish(); await server.close() })
  const generating = sendChat(server, desktop, requestId, question)
  await started
  const stop = (cookie: string, id: string = requestId) => server.inject({ method: 'POST', url: `/api/chat/${id}/stop`, headers: { cookie } })
  try {
    assert.equal((await stop(other)).statusCode, 404)
    assert.equal(signal.aborted, false)
    const stopped = { requestId, text: question, status: 'stopped', content: null }
    assert.deepEqual((await stop(phone)).json(), { turn: stopped })
    assert.equal(signal.aborted, true)
    assert.deepEqual((await stop(desktop)).json(), { turn: stopped })
    assert.deepEqual(await readChat(app, phone), [stopped])
    finish()
    assert.deepEqual(await terminalTurn(await generating), stopped)
    assert.deepEqual(await terminalTurn(await sendChat(server, desktop, requestId, question)), stopped)
    const next = await terminalTurn(await sendChat(server, phone, randomUUID(), '下一条消息'))
    assert.equal(next.status, 'complete')
    assert.deepEqual((await stop(desktop, next.requestId)).json(), { turn: next })
    assert.equal(calls, 2)
    const events = logs.records()
    assert.deepEqual(events.filter(item => item.requestId === requestId && item.attempt === 1)
      .map(item => [item.event, item.outcome]), [
      ['receipt', 'claimed'], ['stop', 'stopped'], ['model', 'stopped'], ['publish', 'stopped'], ['receipt', 'existing'],
    ])
    assert.deepEqual(events.find(item => item.event === 'model' && item.requestId === next.requestId).usage, { inputTokens: 20, outputTokens: 6 })
    assert.doesNotMatch(logs.raw(), /private fixture|preview to discard/)
  } finally { finish() }
})

test('activity discussion persists across sessions and shares its hint receipt with the hint endpoint', async t => {
  const { activityId } = await createTestActivity(pool)
  t.after(() => removeTestActivity(pool, activityId))
  const path = '/api/activities/' + activityId
  const desktop = await login()
  const phone = await login()
  const other = await login('bob@example.test')
  const initial = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: desktop } })).json())
  const chat = (cookie: string, payload: { requestId: string; text: string; revision: number }) =>
    app.inject({ method: 'POST', url: path + '/chat', headers: { cookie }, payload })
  const log = (cookie: string) => app.inject({ url: path + '/chat', headers: { cookie } })
  const historyBefore = await readChat(app, desktop)
  const guess = { requestId: randomUUID(), revision: initial.revision, text: '先不要提示，我猜同伴是另一个目击者。' }
  const response = await chat(desktop, guess)
  assert.equal(response.statusCode, 200)
  const turn = response.json().turn
  assert.equal(turn.text, guess.text)
  assert.equal(turn.status, 'complete')
  assert.equal(turn.intent, 'message')
  assert.ok(turn.reply)
  assert.ok(!turn.reply.includes(memoirCourse.privateContent.hints[0]))
  assert.deepEqual((await chat(phone, guess)).json().turn, turn)
  assert.deepEqual((await log(phone)).json().turns, [turn])
  assert.deepEqual(await readChat(app, phone), historyBefore)
  assert.deepEqual(response.json().activity, initial)
  assert.equal((await log(other)).statusCode, 404)
  assert.equal((await chat(other, guess)).statusCode, 404)

  const help = { ...guess, requestId: randomUUID(), text: '请给我一条提示。' }
  const firstHelp = await chat(phone, help)
  assert.equal(firstHelp.statusCode, 200)
  const { activity: helped, turn: hintTurn } = firstHelp.json()
  assert.equal(hintTurn.intent, 'hint')
  assert.ok(hintTurn.reply.includes(memoirCourse.privateContent.hints[0]))
  assert.deepEqual(helped.hints, memoirCourse.privateContent.hints)
  assert.equal(helped.revision, initial.revision + 1)
  assert.deepEqual((await chat(desktop, help)).json(), firstHelp.json())
  const hintCommand = { activityId, revision: initial.revision, commandId: help.requestId }
  const hint = (cookie: string, payload: typeof hintCommand) => app.inject({
    method: 'POST', url: path + '/hints', headers: { cookie }, payload,
  })
  const replay = await hint(desktop, hintCommand)
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.json().hint, memoirCourse.privateContent.hints[0])
  assert.deepEqual(replay.json().activity, helped)
  assert.deepEqual((await log(desktop)).json().turns, [turn, hintTurn])
  assert.equal((await hint(other, hintCommand)).statusCode, 404)
  assert.equal((await hint(desktop, { ...hintCommand, revision: helped.revision })).statusCode, 409)
  assert.equal((await hint(desktop, { ...hintCommand, commandId: randomUUID(), revision: helped.revision })).statusCode, 409)

})

// Hold the activity until both HTTP requests reach PostgreSQL, then let them contend for the row.
async function raceActivityRequests<T>(activityId: string, start: () => Promise<T>): Promise<T> {
  const gate = await pool.connect()
  let responses: Promise<T> | undefined
  try {
    await gate.query('BEGIN')
    await gate.query('SELECT id FROM activities WHERE id = $1 FOR UPDATE', [activityId])
    responses = start()
    const deadline = Date.now() + 5_000
    for (;;) {
      const waiting = await pool.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `)
      if (waiting.rows[0].count === 2) break
      assert.ok(Date.now() < deadline, 'both requests must be waiting on the locked activity')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally {
    await gate.query('ROLLBACK')
    gate.release()
    await responses
  }
  return responses
}

test('concurrent retries of the same hint publish it once at one revision', async t => {
  const { activityId } = await createTestActivity(pool)
  t.after(() => removeTestActivity(pool, activityId))
  const [phone, desktop] = await Promise.all([login(), login()])
  const path = '/api/activities/' + activityId
  const initial = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: phone } })).json())
  const payload = { activityId, commandId: randomUUID(), revision: initial.revision }
  const [first, second] = await raceActivityRequests(activityId, () => Promise.all([phone, desktop].map(cookie =>
    app.inject({ method: 'POST', url: path + '/hints', headers: { cookie }, payload }))))
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(second.json(), first.json())
  const current = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: desktop } })).json())
  assert.deepEqual(current, first.json().activity)
  assert.equal(current.revision, initial.revision + 1)
  assert.deepEqual(current.hints, [first.json().hint])
  assert.deepEqual(current.hints, memoirCourse.privateContent.hints)
  const receipts = await pool.query('SELECT command_id FROM activity_hint_receipts WHERE activity_id = $1', [activityId])
  assert.deepEqual(receipts.rows, [{ command_id: payload.commandId }])
})

test('two distinct hint requests at the same activity revision release one hint', async t => {
  const { activityId } = await createTestActivity(pool)
  t.after(() => removeTestActivity(pool, activityId))
  const [phone, desktop] = await Promise.all([login(), login()])
  const path = '/api/activities/' + activityId
  const initial = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: desktop } })).json())
  const results = await raceActivityRequests(activityId, () => Promise.all([phone, desktop].map(cookie => app.inject({
    method: 'POST', url: path + '/hints', headers: { cookie },
    payload: { activityId, commandId: randomUUID(), revision: initial.revision },
  }))))
  assert.deepEqual(results.map(response => response.statusCode).sort(), [200, 409])
  const current = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: phone } })).json())
  assert.ok(results.every(response => response.json().activity.revision === current.revision))
  assert.equal(current.revision, initial.revision + 1)
  assert.deepEqual(current.hints, memoirCourse.privateContent.hints)
  const receipts = await pool.query('SELECT command_id FROM activity_hint_receipts WHERE activity_id = $1', [activityId])
  assert.equal(receipts.rowCount, 1)
})

test('activity follow-ups stay isolated and distinguish requested hints from quoted or declined help', async t => {
  const first = await createTestActivity(pool)
  const separate = await createTestActivity(pool)
  t.after(async () => {
    await removeTestActivity(pool, first.activityId)
    await removeTestActivity(pool, separate.activityId)
  })
  const desktop = await login()
  const phone = await login()
  const send = (target: typeof first, cookie: string, text: string) => app.inject({
    method: 'POST', url: '/api/activities/' + target.activityId + '/chat', headers: { cookie },
    payload: { requestId: randomUUID(), revision: 1, text },
  })
  const guess = '不要提示，我猜作者只看到了石阶上的灯。'
  assert.equal((await send(first, desktop, guess)).json().turn.intent, 'message')
  assert.equal((await send(separate, desktop, '我在另一道练习有不同想法。')).statusCode, 200)
  const recall = (await send(first, phone, '我刚才说了什么？')).json()
  assert.equal(recall.turn.reply, '你在这项活动的上一条消息里写道：“' + guess + '”')
  assert.equal((await send(first, phone, '摘录是什么意思？')).json().turn.reply, memoirCourse.publicContent.clarifications[0].text)
  const followup = (await send(first, desktop, '同伴说的是哪一处？')).json()
  assert.match(followup.turn.reply, /给我一条提示/u)
  assert.ok(!followup.turn.reply.includes(memoirCourse.privateContent.hints[0]!))
  const quoted = (await send(first, desktop, '如果我说“请给我一条提示”，会发生什么？')).json()
  assert.equal(quoted.turn.intent, 'message')
  assert.deepEqual(quoted.activity.hints, [])
  const help = (await send(first, phone, '能给我点线索吗？')).json()
  assert.equal(help.turn.intent, 'hint')
  assert.equal(help.turn.reply, memoirCourse.privateContent.hints[0])
})

test('activity chat recovers a received request after hint publication fails and a different device retries', async t => {
  const { activityId } = await createTestActivity(pool)
  t.after(() => removeTestActivity(pool, activityId))
  const phone = await login()
  const desktop = await login()
  const path = '/api/activities/' + activityId + '/chat'
  const command = { revision: 1, requestId: randomUUID(), text: '领取提示' }
  const post = (cookie: string, payload = command) => app.inject({ method: 'POST', url: path, headers: { cookie }, payload })
  await pool.query("ALTER TABLE activity_chat_turns ADD CONSTRAINT test_stop_reply CHECK (status = 'pending') NOT VALID")
  try {
    assert.equal((await post(phone)).statusCode, 500)
    const saved = await app.inject({ url: path, headers: { cookie: desktop } })
    assert.equal(saved.statusCode, 200)
    const snapshot = saved.json()
    assert.deepEqual(snapshot.turns, [{ ...command, intent: 'hint', status: 'pending', reply: null }])
    assert.deepEqual(snapshot.activity.hints, [])
    assert.equal(snapshot.activity.revision, 1)
    assert.equal((await post(desktop, { ...command, requestId: randomUUID(), text: '下一条消息' })).statusCode, 409)
  } finally {
    await pool.query('ALTER TABLE activity_chat_turns DROP CONSTRAINT test_stop_reply')
  }
  const recovered = await post(desktop)
  assert.equal(recovered.statusCode, 200)
  const result = recovered.json()
  assert.equal(result.turn.status, 'complete')
  assert.deepEqual(result.activity.hints, [memoirCourse.privateContent.hints[0]])
  assert.equal(result.activity.revision, 2)
  assert.deepEqual((await post(phone)).json(), result)
})

test('published material supports cited follow-ups and one shared activity across devices', async t => {
  const learner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, learner.id))
  const desktop = await login(learner.email)
  const phone = await login(learner.email)
  const other = await login('bob@example.test')
  const server = createApp(pool, null)
  t.after(() => server.close())
  const list = await server.inject({ url: '/api/chat/materials', headers: { cookie: desktop } })
  assert.equal(list.statusCode, 200)
  const options: ChatMaterialOption[] = list.json().materials
  assert.equal(options.length, 1)
  const [source] = options
  assert.deepEqual(Object.keys(source).sort(), ['question', 'sources', 'supplements', 'title', 'version'])
  const send = (cookie: string, requestId: string, text: string, material: ChatMaterialInput) =>
    server.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { requestId, text, material } })
  const start = (cookie: string, id: string) =>
    server.inject({ method: 'POST', url: '/api/chat/' + id + '/practice', headers: { cookie } })

  const first = await terminalTurn(await send(desktop, randomUUID(), source.question, { version: source.version }))
  assert.equal(first.status, 'complete')
  assert.deepEqual(first.material?.sources, source.sources)
  assert.ok(chatCitations(first.content).length)
  const extra = source.supplements[0]
  assert.ok(!JSON.stringify(first).includes(extra.text))
  const last = await terminalTurn(await send(phone, randomUUID(), source.question, {
    parentRequestId: first.requestId, version: source.version, sourceIds: [extra.id],
  }))
  assert.equal(last.material?.discussionId, first.material?.discussionId)
  assert.notEqual(chatContentText(first.content), chatContentText(last.content))
  assert.ok(chatCitations(last.content).some(citation => citation.id === extra.id))
  for (const turn of [first, last]) {
    for (const citation of chatCitations(turn.content)) {
      assert.ok(citation.quote.trim())
      assert.ok(turn.material?.sources.some(item => item.id === citation.id && item.text.includes(citation.quote)))
    }
  }
  assert.equal((await pool.query('SELECT 1 FROM activities WHERE learner_id = $1', [learner.id])).rowCount, 0)

  assert.equal((await start(other, last.requestId)).statusCode, 404)
  const [a, b] = await Promise.all([start(phone, last.requestId), start(desktop, last.requestId)])
  assert.equal(a.statusCode, 200, a.payload)
  assert.deepEqual(b.json(), a.json())
  const { activityId } = a.json()
  assert.deepEqual((await pool.query('SELECT id FROM activities WHERE learner_id = $1', [learner.id])).rows, [{ id: activityId }])
  const path = '/api/activities/' + activityId
  const current = ActivityViewSchema.parse((await server.inject({ url: path, headers: { cookie: desktop } })).json())
  assert.equal(current.activityVersion, memoirCourse.version)
  assert.equal(current.title, memoirCourse.publicContent.title)
  assert.deepEqual(current.clarifications, memoirCourse.publicContent.clarifications)
  const history = await server.inject({ url: path + '/chat', headers: { cookie: phone } })
  assert.equal(history.statusCode, 200)
  assert.deepEqual(history.json().origin.turns.map((turn: ChatTurn) => turn.requestId), [first.requestId, last.requestId])

  assert.deepEqual(history.json().activity, current)
  assert.deepEqual(history.json().turns, [])
  assert.deepEqual(await readChat(server, phone), [first, last])
  assert.deepEqual(current.allowedActions, ['view', 'requestHint'])
})

test('a learner can ask about their own source without a course and an invented citation never reaches the reply', async t => {
  const learner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, learner.id))
  const cookie = await login(learner.email)
  const fabricated = '花园里有四十座喷泉'
  let attempts = 0
  const server = createApp(pool, async ({ format }) => {
    assert.equal(format, 'json')
    attempts++
    return {
      kind: 'text',
      text: JSON.stringify({ blocks: [{ kind: 'text', text: fabricated, citations: [{ id: 'invented-source', quote: fabricated }] }] }),
    }
  })
  t.after(() => server.close())
  const excerpt = { label: '值班记录（合成）', text: '周一傍晚，值班员在西侧温室数到三盆开花的兰花。' }
  const command = { requestId: randomUUID(), text: '记录中的观察发生在什么时候？', material: { excerpt } }
  const response = await server.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: command })
  assert.equal(response.statusCode, 200, response.payload)
  const turn = await terminalTurn(response)
  assert.equal(attempts, 1)
  assert.equal(turn.explanationMode, 'excerpt')
  assert.equal(turn.material?.version, null)
  assert.ok(chatCitations(turn.content).some(c => c.label === excerpt.label && c.quote.trim() && excerpt.text.includes(c.quote)))
  assert.ok(!response.payload.includes(fabricated))
  assert.deepEqual((await readChat(server, cookie)).at(-1), turn)
  assert.equal((await pool.query('SELECT 1 FROM activities WHERE learner_id = $1', [learner.id])).rowCount, 0)
  const cannotStart = await server.inject({ method: 'POST', url: '/api/chat/' + turn.requestId + '/practice', headers: { cookie } })
  assert.ok(cannotStart.statusCode >= 400 && cannotStart.statusCode < 500)
})

test('a long discussion reads selected evidence across model calls and publishes one reply', async t => {
  const learner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, learner.id))
  const desktop = await login(learner.email)
  const phone = await login(learner.email)
  const rootRequestId = randomUUID()
  const requestId = randomUUID()
  const background = { label: '背景记录', text: '背景'.repeat(1050) + '。' }
  const quote = '设备在 09:05 完成校准。'
  const calibration = { label: '校准记录', text: quote + '同批'.repeat(1050) + '。' }
  const root = await app.inject({
    method: 'POST', url: '/api/chat', headers: { cookie: desktop },
    payload: { requestId: rootRequestId, text: '我想了解这项试验。', material: { excerpt: background } },
  })
  assert.equal(root.statusCode, 200)

  const source = { id: 'excerpt:' + requestId, ...calibration }
  const call = {
    id: 'read-calibration', type: 'function',
    function: { name: 'read_source', arguments: JSON.stringify({ sourceId: source.id }) },
  }
  const repeatedCall = { ...call, id: 'read-calibration-again' }
  let notifyFinalCall!: () => void
  let releaseFinalCall!: () => void
  const finalCall = new Promise<void>(resolve => { notifyFinalCall = resolve })
  const allowReply = new Promise<void>(resolve => { releaseFinalCall = resolve })
  let calls = 0
  const server = createApp(pool, createChatCompletionsModel({
    env: { STUDY_AGENT_API_KEY: 'test-credential', STUDY_AGENT_BASE_URL: 'https://model.example.test/v1/' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(String(options?.body))
      assert.equal(body.tools[0].function.name, 'read_source')
      calls++
      if (calls === 1) {
        assert.deepEqual(JSON.parse(body.messages[1].content).sources, [
          { id: 'excerpt:' + rootRequestId, label: background.label }, { id: source.id, label: calibration.label },
        ])
        assert.ok(!JSON.stringify(body).includes(quote))
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call] } }] })
      }
      assert.deepEqual(body.messages[2], { role: 'assistant', content: null, tool_calls: [call] })
      const { content, ...toolMessage } = body.messages[3]
      assert.deepEqual(toolMessage, { role: 'tool', tool_call_id: call.id })
      assert.deepEqual(JSON.parse(content), source)
      if (calls === 2) {
        assert.equal(body.messages.length, 4)
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [repeatedCall] } }] })
      }
      assert.equal(calls, 3)
      assert.equal(body.tool_choice, 'none')
      assert.equal(body.messages.length, 6)
      assert.deepEqual(body.messages[4], { role: 'assistant', content: null, tool_calls: [repeatedCall] })
      const { content: reference, ...repeatedMessage } = body.messages[5]
      assert.deepEqual(repeatedMessage, { role: 'tool', tool_call_id: repeatedCall.id })
      assert.deepEqual(JSON.parse(reference), { id: source.id, previousToolCallId: call.id })
      notifyFinalCall()
      await allowReply
      const text = JSON.stringify({ blocks: [{ kind: 'text', text: '校准完成时间是 09:05。', citations: [{ id: source.id, quote }] }] })
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: text } }] })
    },
  }))
  t.after(() => { releaseFinalCall(); return server.close() })

  const question = '设备什么时候完成校准？'
  const received = server.inject({
    method: 'POST', url: '/api/chat', headers: { cookie: desktop },
    payload: { requestId, text: question, material: { parentRequestId: rootRequestId, excerpt: calibration } },
  })
  await Promise.race([finalCall, received.then(response =>
    assert.fail(`Expected the final model call, got HTTP ${response.statusCode} after ${calls} calls`))])
  try {
    const pending = (await readChat(server, phone)).at(-1)
    assert.equal(pending?.requestId, requestId)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.content, null)
    assert.deepEqual(await terminalTurn(await sendChat(server, phone, requestId, question)), pending)
  } finally {
    releaseFinalCall()
  }

  const completed = await received
  assert.equal(completed.statusCode, 200)
  const stream = new Response(completed.payload, { headers: { 'Content-Type': String(completed.headers['content-type']) } })
  const progress: string[] = []
  for await (const data of readServerEvents(stream)) {
    const event = JSON.parse(data)
    if (event.kind === 'progress') progress.push(event.progress)
  }
  assert.deepEqual(progress, ['reading_sources', 'checking_citations'])
  const turn = await terminalTurn(completed)
  assert.equal(turn.explanationMode, 'model')
  assert.equal(chatContentText(turn.content), '校准完成时间是 09:05。')
  assert.deepEqual(chatCitations(turn.content), [{ id: source.id, label: source.label, quote }])
  assert.deepEqual((await readChat(server, phone)).filter(item => item.requestId === requestId), [turn])
  assert.deepEqual(await terminalTurn(await sendChat(server, phone, requestId, question)), turn)
  assert.equal(calls, 3)
})

test('learning dialogue uses learner-provided excerpts and does not attach private activity material', async t => {
  const learner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, learner.id))
  const cookie = await login(learner.email)
  const created = await inTransaction(pool, db => createActivity(db, learner.id, memoirCourse.version))
  assert.ok(created)
  const details = await app.inject({ url: '/api/activities/' + created.activityId, headers: { cookie } })
  const activity = ActivityViewSchema.parse(details.json())
  const quote = activity.materials[0].text
  const hint = memoirCourse.privateContent.hints[0]
  const server = createApp(pool, async ({ format, messages }) => {
    assert.ok(!JSON.stringify(messages).includes(hint))
    if (format === 'text') {
      assert.ok(!JSON.stringify(messages).includes(quote))
      return { kind: 'text', text: '可以查找你感兴趣的资料。' }
    }
    const prompt: MaterialPrompt = JSON.parse(messages[0].content!)
    assert.deepEqual(prompt.sources.map(source => source.text), [quote])
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'excerpt', source: { id: prompt.sources[0].id, quote } }],
    }) }
  })
  t.after(() => server.close())

  assert.equal((await terminalTurn(await sendChat(server, cookie, randomUUID(), '怎么读回忆录？'))).status, 'complete')
  const reply = await terminalTurn(await server.inject({
    method: 'POST', url: '/api/chat', headers: { cookie },
    payload: { requestId: randomUUID(), text: '这段记录说了什么？', material: { excerpt: { label: '阅读笔记', text: quote } } },
  }))
  assert.equal(reply.explanationMode, 'model')
  assert.equal(chatCitations(reply.content)[0].quote, quote)
})

test('memory authorization also fences inherited history, buffered output and replay across devices', { timeout: 10_000 }, async t => {
  const owner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, owner.id))
  const desktop = await login(owner.email)
  const phone = await login(owner.email)
  const other = await login('bob@example.test')
  const secret = '用星座卡片逐步练习'
  const details = { kind: 'statement', body: secret, topic: '星图', expiresAt: null, authorized: true }
  const create = { ...details, operation: 'remember', commandId: randomUUID() }
  const change = (cookie: string, payload: object) => app.inject({ method: 'POST', url: '/api/memories', headers: { cookie }, payload })
  const list = (cookie: string) => app.inject({ url: '/api/memories', headers: { cookie } })
  const first = await change(desktop, create)
  assert.equal(first.statusCode, 200, first.payload)
  assert.deepEqual((await change(phone, create)).json(), first.json())
  assert.equal((await change(phone, { ...create, body: '另一条记忆' })).statusCode, 409)
  assert.deepEqual((await list(other)).json(), { memories: [] })

  let started!: () => void
  let release!: () => void
  const blocked = new Promise<void>(resolve => { started = resolve })
  const finish = new Promise<void>(resolve => { release = resolve })
  const inputs: string[] = []
  let delay = true
  const logs = captureLogs()
  const server = createApp(pool, async ({ messages, onTextDelta }) => {
    const input = JSON.stringify(messages)
    inputs.push(input)
    const text = input.includes(secret) ? secret : '从一个小例子开始。'
    onTextDelta?.(text)
    if (messages.at(-1)?.content === '星图进阶' && delay) {
      delay = false
      started()
      await finish
    }
    return { kind: 'text', text }
  }, undefined, undefined, { logger: logs.logger })
  t.after(() => { release(); return server.close() })

  const seen = await terminalTurn(await sendChat(server, desktop, randomUUID(), '星图入门'))
  assert.equal(chatContentText(seen.content), secret)
  assert.equal((await app.inject({ url: '/api/memories/source/' + seen.requestId, headers: { cookie: other } })).statusCode, 404)
  assert.equal((await change(other, { ...create, commandId: randomUUID(), sourceRequestId: seen.requestId })).statusCode, 400)
  await sendChat(server, desktop, randomUUID(), '研究月球')
  assert.ok(!inputs.at(-1)?.includes(secret), 'derived history must honor the same topic restriction')

  const requestId = randomUUID()
  const pending = sendChat(server, desktop, requestId, '星图进阶')
  await blocked
  const revision = first.json().memories[0].revision
  const revoke = { ...details, operation: 'correct', commandId: randomUUID(), id: create.commandId, revision, authorized: false }
  const updated = await change(phone, revoke)
  release()
  assert.equal(updated.statusCode, 200, updated.payload)
  const stale = await pending
  assert.ok(!stale.payload.includes(secret))
  assert.equal((await terminalTurn(stale)).status, 'retryable')
  assert.equal(logs.records().find(item => item.event === 'publish' && item.requestId === requestId).outcome, 'memory_invalidated')
  assert.ok(!logs.raw().includes(secret))
  const recovered = await terminalTurn(await sendChat(server, phone, requestId, '星图进阶'))
  assert.equal(recovered.status, 'complete')
  assert.ok(!inputs.at(-1)?.includes(secret))
  const expired = (await readChat(server, phone)).find(turn => turn.requestId === seen.requestId)
  assert.deepEqual(expired?.content, [{ kind: 'unavailable', id: seen.content![0].id }])
  assert.equal((await change(desktop, { ...revoke, commandId: randomUUID() })).statusCode, 409)

  const forget = { operation: 'forget', commandId: randomUUID(), id: create.commandId, revision: updated.json().memories[0].revision }
  assert.deepEqual((await change(phone, forget)).json(), { memories: [] })
  assert.deepEqual((await change(desktop, create)).json(), { memories: [] })
  assert.equal((await pool.query('SELECT body FROM personal_memories WHERE learner_id = $1', [owner.id])).rows[0].body, null)
})

test('a summary can reclaim an expired job, stays in its branch and discards obsolete results', { timeout: 10_000 }, async t => {
  const learner = await createTestLearner(pool)
  t.after(() => removeTestLearner(pool, learner.id))
  const phone = await login(learner.email)
  const desktop = await login(learner.email)
  const inputs: { history: unknown; memory?: string }[] = []
  const excerpt = { label: '记录', text: '馆藏在周一登记。' }
  const root = randomUUID()
  const sourceId = 'excerpt:' + root
  const server = createApp(pool, async ({ messages }) => {
    inputs.push(JSON.parse(messages[0].content!))
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'text', text: '可以对照登记记录。', citations: [{ id: sourceId, quote: excerpt.text }] }],
    }) }
  })
  t.after(() => server.close())
  const send = (cookie: string, requestId: string, text: string, material: ChatMaterialInput) =>
    server.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { requestId, text, material } }).then(terminalTurn)

  await send(desktop, root, '看看馆藏记录', { excerpt })
  let parent = root
  for (let index = 1; index <= 22; index++) {
    const id = randomUUID()
    assert.equal((await send(desktop, id, '甲分支问题 ' + index, { parentRequestId: parent })).status, 'complete')
    parent = id
  }
  await pool.query(`
    UPDATE conversation_summaries SET attempt = 1, lease_until = clock_timestamp() - interval '1 second' WHERE learner_id = $1
  `, [learner.id])
  const summarize: StudyModel = async ({ messages }) => {
    const rows = JSON.parse(messages[0].content!)
    const last = rows.at(-1)
    return { kind: 'text', text: JSON.stringify({ notes: [{ kind: 'question', requestId: last.requestId, quote: last.text }] }) }
  }
  const config = async () => ({ model: summarize, settings: defaultAgentSettings })
  assert.equal(await processNextSummary(pool, config), true)
  assert.equal(await processNextSummary(pool, config), true)
  const remaining = await pool.query('SELECT attempt, status FROM conversation_summaries WHERE learner_id = $1', [learner.id])
  assert.deepEqual(remaining.rows, [{ attempt: 2, status: 'complete' }, { attempt: 2, status: 'complete' }])

  await send(phone, randomUUID(), '乙分支的问题', { parentRequestId: root })
  assert.equal(inputs.at(-1)?.memory, undefined)
  await send(phone, randomUUID(), '接续甲分支', { parentRequestId: parent })
  assert.match(inputs.at(-1)?.memory ?? '', /甲分支问题 1"/)
  assert.ok(!JSON.stringify(inputs.at(-1)?.history).includes('甲分支问题 1"'))

  const memoryId = randomUUID()
  const change = (payload: object) => app.inject({ method: 'POST', url: '/api/memories', headers: { cookie: phone }, payload })
  const record = { kind: 'wish', body: '了解馆藏档案', authorized: true, topic: '', expiresAt: null }
  assert.equal((await change({ ...record, operation: 'remember', commandId: memoryId })).statusCode, 200)
  let claimed!: () => void
  let finish!: () => void
  const started = new Promise<void>(resolve => { claimed = resolve })
  const ready = new Promise<void>(resolve => { finish = resolve })
  const work = processNextSummary(pool, async () => ({
    settings: defaultAgentSettings,
    model: async input => { claimed(); await ready; return summarize(input) },
  }))
  await started
  const correction = await change({ ...record, operation: 'correct', commandId: randomUUID(),
    id: memoryId, revision: 1, body: '了解登记日期' })
  finish()
  assert.equal(correction.statusCode, 200, correction.payload)
  assert.equal(await work, true)
  assert.equal((await pool.query("SELECT 1 FROM conversation_summaries WHERE learner_id = $1 AND summary IS NOT NULL", [learner.id])).rowCount, 0)
})
