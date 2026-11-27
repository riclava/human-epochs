import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Writable } from 'node:stream'
import { Pool } from 'pg'
import { createApp } from '../src/app/create-app.js'
import { processNextSummary } from '../src/app/conversation/summaries.js'
import { createChatCompletionsModel } from '../src/models/chat-completions.js'
import { createModelProvider } from '../src/models/connections.js'
import { requestPublicModel } from '../src/models/public-model-request.js'
import { createModelCredentialCipher } from '../src/storage/model-credential.js'
import { migrate } from '../src/storage/migrate.js'
import { seed } from '../src/storage/seed.js'
import { ActivityViewSchema } from '../src/contracts/activity.js'
import { agentSettingsViewSchema, defaultAgentSettings, deepSeekOutputLimit, type SaveAgentSettingsRequest } from '../src/contracts/agent-settings.js'
import { conversationContentText, type ConversationMaterialSelection, type ConversationMaterialOption, type ConversationSnapshot, type ConversationTurn, type ReviewInvitationCommand } from '../src/contracts/conversation.js'
import { readServerEvents } from '../src/contracts/event-stream.js'
import type { User } from '../src/contracts/session.js'
import { createTestActivity, createTestUser, removeTestActivity, removeTestUser } from './fixtures/activity.js'
import { conversationCitations, modelChunk, readConversationTurn } from './fixtures/conversation-stream.js'
import { memoirCourse, publishedDiscussions } from '../src/courses/catalog.js'
import { inTransaction } from '../src/storage/transaction.js'
import { createActivity } from '../src/activities/activities.js'
import type { MaterialPrompt, ModelMessage, ModelClient } from '../src/runtime/model.js'

// Every user in this file talks in a conversation with this ID; each user gets their own conversation row.
const conversationId = randomUUID()

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

test('AI review schedules from a course and resumes, defers, answers and stops through the conversation', async t => {
  const user = await createTestUser(pool)
  const cookie = await login(user.email)
  const stranger = await login('bob@example.test')
  const discussion = publishedDiscussions[0]!
  const source = discussion.sources[0]!
  const topic = '亲历和转述'
  const firstQuestion = '如果回忆出自别人之口，能证明作者亲历吗？'
  const nextQuestion = '如果作者只听说下雪，能确认作者见过雪吗？'
  const answer = '只能证明作者听说过，不能证明亲历。'
  let time = new Date('2026-11-27T08:00:00Z').getTime()
  const now = () => new Date(time)
  const advance = (hours: number) => { time += hours * 3_600_000 }
  const model: ModelClient = async ({ format, messages }) => {
    assert.equal(format, 'json')
    const prompt = JSON.parse(messages.at(-1)!.content!) as MaterialPrompt
    if (prompt.question === '我改问月相。') return { kind: 'text', text: JSON.stringify({ otherTopic: '月相是月球受光部分的视形状。' }) }
    assert.equal(prompt.offerReview, prompt.question.startsWith('继续聊') ? undefined : true)
    if (prompt.review) {
      assert.deepEqual(prompt.review, { question: firstQuestion, answer })
      assert.equal(prompt.question, answer)
    }
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'text', text: prompt.review ? '你正确区分了转述和亲历。' : '这句话是在转述姨母的话。',
        citations: [{ sourceId: source.id, quote: source.text }] }],
      reviewAnswered: !!prompt.review,
      review: { topic, question: prompt.review ? nextQuestion : firstQuestion, answer, afterDays: 2,
        sourceId: source.id, quote: source.text },
    }) }
  }
  const newServer = () => createApp(pool, model, undefined, undefined, { reviewNow: now })
  const desktop = newServer()
  const phone = newServer()
  t.after(async () => { await desktop.close(); await phone.close(); await removeTestUser(pool, user.id) })
  const headers = { cookie }
  const snapshot = async (server = desktop) => (await server.inject({ url: '/api/conversations/' + conversationId, headers })).json<ConversationSnapshot>()
  const command = (action: ReviewInvitationCommand['action'], reviewInvitationId: string) => ({ conversationId, action, reviewInvitationId, commandId: randomUUID() })
  const operate = (payload: ReviewInvitationCommand, server = desktop, cookieHeader = cookie) => server.inject({
    method: 'POST', url: '/api/conversation/review-invitations', headers: { cookie: cookieHeader }, payload,
  })
  async function send(text: string, reviewInvitationId?: string) {
    const response = await desktop.inject({ method: 'POST', url: '/api/conversation', headers,
      payload: { conversationId, requestId: randomUUID(), messageText: text, reviewInvitationId } })
    assert.equal(response.statusCode, 200)
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }

  assert.equal((await snapshot()).starter?.discussionVersion, discussion.discussionVersion)
  assert.equal((await send(`聊聊《${discussion.title}》`)).status, 'complete')
  assert.equal((await snapshot()).reviewInvitation, undefined)
  advance(48)
  const invitation = (await snapshot(phone)).reviewInvitation!
  assert.deepEqual(invitation, { reviewInvitationId: invitation.reviewInvitationId, topic, sourceLabel: source.label })
  assert.equal((await operate(command('accept', invitation.reviewInvitationId), desktop, stranger)).statusCode, 404)
  const defer = command('later', invitation.reviewInvitationId)
  assert.equal((await operate(defer)).statusCode, 200)
  assert.equal((await snapshot(phone)).reviewInvitation, undefined)
  advance(12)
  assert.equal((await operate(defer, phone)).statusCode, 200)
  advance(12)
  assert.equal((await snapshot(phone)).reviewInvitation?.reviewInvitationId, invitation.reviewInvitationId)

  const accepted = await Promise.all([operate(command('accept', invitation.reviewInvitationId)), operate(command('accept', invitation.reviewInvitationId), phone)])
  for (const result of accepted) {
    assert.equal(result.statusCode, 200, result.payload)
    const view = result.json<ConversationSnapshot>()
    assert.equal(view.reviewInvitation, undefined)
    assert.equal(view.turns.filter(turn => turn.kind === 'review_question' && turn.reviewInvitationId === invitation.reviewInvitationId).length, 1)
    const question = view.turns.at(-1)!
    assert.equal(question.kind, 'review_question')
    assert.deepEqual(Object.keys(question).sort(), ['kind', 'questionBlocks', 'requestId', 'reviewInvitationId', 'status'])
    assert.equal(conversationContentText(question.questionBlocks), firstQuestion)
    assert.ok(!result.payload.includes(answer))
  }
  assert.equal(accepted[0]!.json<ConversationSnapshot>().turns.at(-1)!.requestId, accepted[1]!.json<ConversationSnapshot>().turns.at(-1)!.requestId)
  const feedback = await send(answer, invitation.reviewInvitationId)
  assert.equal(conversationContentText(feedback.replyBlocks), '你正确区分了转述和亲历。')
  assert.equal((await snapshot()).reviewInvitation, undefined)
  advance(48)
  const second = (await snapshot(phone)).reviewInvitation!
  assert.notEqual(second.reviewInvitationId, invitation.reviewInvitationId)
  const next = (await operate(command('accept', second.reviewInvitationId))).json<ConversationSnapshot>()
  const nextQuestionTurn = next.turns.at(-1)!
  assert.equal(nextQuestionTurn.kind, 'review_question')
  assert.equal(conversationContentText(nextQuestionTurn.questionBlocks), nextQuestion)
  assert.equal(conversationContentText((await send('我改问月相。', second.reviewInvitationId)).replyBlocks), '月相是月球受光部分的视形状。')
  advance(48)
  assert.equal((await snapshot()).reviewInvitation, undefined)

  await send(`再聊一次《${discussion.title}》`)
  advance(48)
  const stop = command('stop', (await snapshot()).reviewInvitation!.reviewInvitationId)
  assert.equal((await operate(stop)).statusCode, 200)
  assert.equal((await operate(stop, phone)).statusCode, 200)
  assert.equal((await send(`继续聊《${discussion.title}》`)).explanationSource, 'model')
  advance(48)
  assert.equal((await snapshot(phone)).reviewInvitation, undefined)
})

test('an invalid review proposal leaves the lesson intact and deleted evidence hides a published question', async t => {
  const user = await createTestUser(pool)
  const cookie = await login(user.email)
  const discussion = publishedDiscussions[0]!
  const source = discussion.sources[0]!
  let time = Date.parse('2026-11-27T08:00:00Z')
  let answerStarted!: () => void
  const enteredModel = new Promise<void>(resolve => { answerStarted = resolve })
  let completeModel!: () => void
  const waitForSourceChange = new Promise<void>(resolve => { completeModel = resolve })
  const server = createApp(pool, async ({ messages }) => {
    const input = JSON.parse(messages.at(-1)!.content!) as MaterialPrompt
    if (input.review) {
      answerStarted()
      await waitForSourceChange
    }
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'text', text: '这是作者转述的说法。', citations: [{ sourceId: source.id, quote: source.text }] }],
      review: { topic: '转述', question: '这是亲历吗？', answer: '这是转述。', afterDays: 1,
        sourceId: source.id, quote: input.question === '正确引用' ? source.text : '不存在的引文' },
    }) }
  }, undefined, undefined, { reviewNow: () => new Date(time) })
  t.after(async () => { completeModel(); await server.close(); await removeTestUser(pool, user.id) })
  const headers = { cookie }
  const snapshot = async () => (await server.inject({ url: '/api/conversations/' + conversationId, headers })).json<ConversationSnapshot>()
  async function discuss(text: string) {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers, payload: {
      conversationId, requestId: randomUUID(), messageText: text, materialSelection: { discussionVersion: discussion.discussionVersion },
    } })
    assert.equal(response.statusCode, 200)
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  assert.equal(conversationContentText((await discuss('错误引用')).replyBlocks), '这是作者转述的说法。')
  time += 86_400_000
  assert.equal((await snapshot()).reviewInvitation, undefined)
  const origin = await discuss('正确引用')
  time += 86_400_000
  const invite = (await snapshot()).reviewInvitation!
  const payload = { conversationId, action: 'accept', reviewInvitationId: invite.reviewInvitationId, commandId: randomUUID() }
  const accept = () => server.inject({ method: 'POST', url: '/api/conversation/review-invitations', headers, payload })
  const accepted = await accept()
  assert.equal(accepted.statusCode, 200, accepted.payload)
  const asMemorySource = { operation: 'remember', commandId: randomUUID(), sourceRequestId: payload.commandId,
    kind: 'statement', body: '我想留下这条操作。', topic: '', expiresAt: null, authorizedForTutoring: false }
  assert.equal((await server.inject({ method: 'POST', url: '/api/personal-memories', headers, payload: asMemorySource })).statusCode, 400)
  const answering = server.inject({ method: 'POST', url: '/api/conversation', headers, payload: {
    conversationId, requestId: randomUUID(), messageText: '这是转述。', reviewInvitationId: invite.reviewInvitationId,
  } })
  await Promise.race([enteredModel, answering.then(result => { throw new Error('Expected a held model call: ' + result.statusCode) })])
  await pool.query(`UPDATE conversation_turns SET reply_blocks = jsonb_build_array(
    jsonb_build_object('kind', 'unavailable', 'id', reply_blocks->0->>'id')) WHERE user_id = $1 AND request_id = $2`,
  [user.id, origin.requestId])
  completeModel()
  const answered = await answering
  const discarded = await readConversationTurn(answered.payload, String(answered.headers['content-type']))
  assert.equal(discarded.status, 'failed')
  assert.equal(discarded.replyBlocks, null)
  const restored = (await accept()).json<ConversationSnapshot>()
  const question = restored.turns.find(turn => turn.requestId === payload.commandId)!
  assert.equal(question.kind, 'review_question')
  assert.equal(question.reviewInvitationId, undefined)
  assert.equal(question.questionBlocks[0]?.kind, 'unavailable')
  assert.ok(!JSON.stringify(restored).includes('这是亲历吗？'))
  assert.equal((await server.inject({ url: '/api/personal-memories/source/' + payload.commandId, headers })).statusCode, 404)
  assert.equal((await server.inject({ method: 'POST', url: '/api/conversation', headers, payload: {
    conversationId, requestId: randomUUID(), messageText: '仍然作答', reviewInvitationId: invite.reviewInvitationId,
  } })).statusCode, 409)
})

test('only configured administrators can save versioned runtime settings and an active attempt keeps its settings', async t => {
  const account = await createTestUser(pool)
  t.after(() => removeTestUser(pool, account.id))
  const owner = await login()
  const user = await login(account.email)
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
      text: JSON.stringify({ blocks: [{ kind: 'text', text: '校准在 09:05 完成。', citations: [{ sourceId: sourceId, quote: sourceText }] }] }),
    }
  }, ' Alice@EXAMPLE.TEST ')
  t.after(async () => {
    finishToolCall()
    await server.close()
    await pool.query('DELETE FROM agent_settings')
  })

  const url = '/api/agent-settings'
  const read = (cookie?: string) => server.inject({ url, headers: cookie ? { cookie } : {} })
  const save = (cookie: string, payload: SaveAgentSettingsRequest) => server.inject({ method: 'PUT', url, headers: { cookie }, payload })
  assert.equal((await read()).statusCode, 401)
  assert.equal((await read(user)).statusCode, 403)
  const { revision, settings, onlineModelAvailable } = agentSettingsViewSchema.parse((await read(owner)).json())
  assert.equal(onlineModelAvailable, true)
  const initial = { expectedRevision: revision, settings }
  assert.deepEqual(initial, { expectedRevision: 0, settings: defaultAgentSettings })
  assert.equal((await save(user, initial)).statusCode, 403)
  assert.equal((await save(owner, { ...initial, settings: { ...initial.settings, historyBytes: 100 } })).statusCode, 400)
  const proposed = { ...initial, settings: { ...initial.settings, maxOutputTokens: 3_072, inlineSourceChars: 500, maxModelCalls: 2 } }
  const outcomes = await Promise.all([save(owner, proposed), save(owner, proposed)])
  assert.deepEqual(outcomes.map(result => result.statusCode).sort(), [200, 409])
  const published = agentSettingsViewSchema.parse(outcomes.find(result => result.statusCode === 200)!.json())
  const saved = { revision: published.revision, settings: published.settings }
  assert.deepEqual(saved, { revision: 1, settings: proposed.settings })

  const received = server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: user }, payload: {
    conversationId, requestId, messageText: '设备什么时候完成校准？',
    materialSelection: { excerpt: { label: '设备记录', text: sourceText + '背景'.repeat(300) } },
  } })
  await Promise.race([modelStarted, received.then(response => assert.fail(`Expected a tool call before posting status ${response.statusCode}`))])
  try {
    const result = await save(owner, { expectedRevision: saved.revision, settings: { ...saved.settings, maxOutputTokens: 4_096, maxModelCalls: 5 } })
    assert.equal(result.statusCode, 200)
  } finally {
    finishToolCall()
  }
  const completed = await received
  assert.equal(completed.statusCode, 200)
  assert.equal((await terminalTurn(completed)).explanationSource, 'model')
  assert.equal((await sendConversation(server, user, randomUUID(), '可以问个新问题吗？')).statusCode, 200)
  assert.deepEqual(calls, [
    { tokens: 3_072, toolChoice: undefined },
    { tokens: 3_072, toolChoice: 'none' },
    { tokens: 4_096, toolChoice: undefined },
  ])
})

test('the model form stores a write-only key bound to its URL and the settings assistant cannot edit credentials', async t => {
  const account = await createTestUser(pool)
  t.after(() => removeTestUser(pool, account.id))
  const owner = await login()
  const user = await login(account.email)
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
  const provider = createModelProvider({ MODEL_API_KEY: 'default-test-key' }, fetchImpl, fetchImpl)
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
  assert.equal((await ask(user)).statusCode, 403)
  const result = await ask(owner)
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.json(), advice)
  assert.deepEqual(await read(), initial)
  advice = { ...advice, changes: { apiKey: 'injected-key', baseUrl: 'https://elsewhere.example.test' } }
  assert.equal((await ask(owner)).statusCode, 502)
  assert.deepEqual(await read(), initial)

  const save = (command: SaveAgentSettingsRequest, cookie = owner) => server.inject({ method: 'PUT', url, headers: { cookie }, payload: command })
  const command = { expectedRevision: initial.revision, settings: { ...initial.settings, maxOutputTokens: 4_096 }, connection }
  const denied = await save(command)
  assert.equal(denied.statusCode, 400)
  assert.equal(denied.json().field, 'apiKey')
  const blocked = await save({ ...command, connection: { ...connection, baseUrl: 'https://127.0.0.1:8443', apiKey: 'test-key' } })
  assert.equal(blocked.statusCode, 400)
  assert.equal(blocked.json().field, 'baseUrl')
  await assert.rejects(requestPublicModel('https://[::ffff:127.0.0.1]/v1/chat/completions'))
  assert.equal((await sendConversation(server, user, randomUUID(), '请帮我制定练习步骤。')).statusCode, 200)
  const keyed = { ...command, connection: { ...connection, apiKey: 'alternate-test-key' } }
  assert.equal((await save(keyed, user)).statusCode, 403)
  const saved = await save(keyed)
  assert.equal(saved.statusCode, 200)
  assert.ok(!saved.payload.includes('alternate-test-key'))
  assert.deepEqual((await read()).connection, { ...connection, hasApiKey: true })
  const { rows: [persisted] } = await pool.query('SELECT settings, connection FROM agent_settings')
  assert.deepEqual(persisted.settings, command.settings)
  assert.ok(!JSON.stringify(persisted).includes('alternate-test-key'))
  assert.throws(() => cipher.open(persisted.connection.sealedApiKey, 'https://other.example.test'))
  assert.equal(cipher.open(persisted.connection.sealedApiKey, connection.baseUrl), 'alternate-test-key')
  assert.equal((await save({ ...command, expectedRevision: 1, connection: { ...connection, modelId: 'team/small' } })).statusCode, 200)
  assert.equal((await sendConversation(server, user, randomUUID(), '接下来应该做什么？')).statusCode, 200)
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
  assert.equal(first.courseVersion, memoirCourse.version)
  assert.deepEqual(first.allowedActions, ['view', 'requestHint'])
})

test('hidden content stays server-side and cross-user access is denied', async () => {
  const alice = await login()
  const bob = await login('bob@example.test')
  const first = await activity(alice)
  assert.notEqual((await activity(bob)).activityId, first.activityId)
  const path = '/api/activities/' + first.activityId
  assert.equal((await app.inject({ url: path })).statusCode, 401)
  assert.equal((await app.inject({ url: path, headers: { cookie: bob } })).statusCode, 404)
  assert.equal((await app.inject({ url: path + '/hints', headers: { cookie: alice } })).statusCode, 404)
  assert.deepEqual(first.claimedHints, [])
  assert.equal(JSON.stringify(first).includes(memoirCourse.privateContent.hints[0]!), false)
  const escalation = await app.inject({
    url: path + '?include=unpublishedHints',
    headers: { cookie: alice },
  })
  assert.equal(escalation.statusCode, 200)
  assert.deepEqual(escalation.json(), first)
})

test('login verifies credentials; logout and expiry revoke session access', async () => {
  const email = 'alice@example.test'
  const invalid = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { email, password: 'incorrect' },
  })
  assert.equal(invalid.statusCode, 401)
  const signedIn = await app.inject({
    method: 'POST', url: '/api/login',
    payload: { email, password: 'HumanEpochs-demo-1!' },
  })
  assert.equal(signedIn.statusCode, 200)
  const identity = signedIn.json<{ user: User }>()
  assert.deepEqual(Object.keys(identity), ['user'])
  const { rows: [account] } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])
  assert.equal(identity.user.id, account.id)
  assert.equal(identity.user.email, email)

  const cookie = String(signedIn.headers['set-cookie']).split(';', 1)[0]
  const session = await app.inject({ url: '/api/session', headers: { cookie, 'x-user-id': identity.user.id } })
  assert.equal(session.statusCode, 200)
  assert.deepEqual(session.json(), identity)
  const logout = await app.inject({ method: 'POST', url: '/api/logout', headers: { cookie } })
  assert.ok([200, 204].includes(logout.statusCode))
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie } })).statusCode, 401)
  const expiring = await login()
  await pool.query("UPDATE sessions SET expires_at = now() - interval '1 hour'")
  assert.equal((await app.inject({ url: '/api/session', headers: { cookie: expiring } })).statusCode, 401)
})

test('retired domain routes and table names are unavailable', async () => {
  const cookie = await login()
  const { activityId } = await activity(cookie)
  for (const path of ['/api/chat', '/api/activities/' + activityId + '/chat', '/api/memories']) {
    assert.equal((await app.inject({ url: path, headers: { cookie } })).statusCode, 404, path)
  }
  const { rows } = await pool.query<{ relation: string | null }>(`
    SELECT to_regclass('public.' || name)::text AS relation
    FROM unnest($1::text[]) AS retired(name)
  `, [[
    'chat_turns', 'activity_chat_turns', 'chat_memory_sources', 'curriculum_versions',
    'discussion_practices', 'review_command_receipts', 'memory_command_receipts',
  ]])
  assert.ok(rows.every(row => row.relation === null))
})

test('migrations and course seeding can run again without replacing progress', async () => {
  const cookie = await login()
  const initial = await activity(cookie)
  const received = await app.inject({
    method: 'POST', url: '/api/activities/' + initial.activityId + '/hints', headers: { cookie },
    payload: { activityId: initial.activityId, expectedRevision: initial.revision, commandId: randomUUID() },
  })
  assert.equal(received.statusCode, 200, received.payload)
  const original = await activity(cookie)
  assert.deepEqual(original.claimedHints, memoirCourse.privateContent.hints.slice(0, 1))
  await migrate(pool)
  await seed(pool)
  assert.deepEqual(await activity(cookie), original)
  assert.equal((await pool.query('SELECT * FROM users')).rowCount, 2)
  assert.equal((await pool.query('SELECT id FROM activities')).rowCount, 2)
  assert.deepEqual((await pool.query('SELECT version FROM course_versions')).rows, [{ version: memoirCourse.version }])
})

const emptyMemories = { memories: [], candidates: [], suggestionsEnabled: false, suggestionsPending: false }

function sendConversation(server: typeof app, cookie: string, requestId: string, text: string) {
  return server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { conversationId, requestId, messageText: text } })
}

function terminalTurn(response: Awaited<ReturnType<typeof sendConversation>>) {
  assert.equal(response.statusCode, 200, response.payload)
  return readConversationTurn(response.payload, String(response.headers['content-type']))
}

async function readConversation(server: typeof app, cookie: string): Promise<ConversationTurn[]> {
  const response = await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })
  assert.equal(response.statusCode, 200)
  assert.ok(['guided', 'model'].includes(response.json().mode))
  return response.json().turns
}

function captureLogs() {
  const lines: string[] = []
  const stream = new Writable({ write(chunk, _encoding, done) { lines.push(String(chunk)); done() } })
  return { logger: { stream }, raw: () => lines.join(''), records: () => lines.join('').trim().split('\n').map(line => JSON.parse(line)) }
}

test('conversation saves the question before generation, orders follow-ups and isolates users', async t => {
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
  assert.equal((await server.inject({ url: '/api/conversations/' + conversationId })).statusCode, 401)
  assert.equal((await server.inject({
    method: 'POST', url: '/api/conversation', headers: { cookie: alice, 'x-user-id': randomUUID() },
    payload: { conversationId, requestId, messageText: question },
  })).statusCode, 401)
  for (const invalid of ['   ', 'x'.repeat(4001), 'bad\u0000text']) {
    assert.equal((await sendConversation(server, alice, requestId, invalid)).statusCode, 400)
  }
  const generating = sendConversation(server, alice, requestId, question)
  await started
  const pending: ConversationTurn = { requestId, kind: 'user', messageText: question, replyBlocks: null, status: 'pending' }
  assert.deepEqual(await readConversation(server, secondDevice), [pending])
  assert.deepEqual(await readConversation(server, bob), [])
  assert.deepEqual(await terminalTurn(await sendConversation(server, alice, requestId, question)), pending)
  assert.equal((await sendConversation(server, alice, requestId, 'changed')).statusCode, 409)
  assert.equal((await sendConversation(server, secondDevice, randomUUID(), '新的问题')).statusCode, 409)
  const bobTurn = await sendConversation(server, bob, requestId, '我想读图表')
  assert.equal(bobTurn.statusCode, 200)
  assert.deepEqual(histories[1], [{ role: 'user', content: '我想读图表' }])
  finishFirst('你想讨论按钮，还是服务端的写入规则？')
  const result = await generating
  assert.equal(result.statusCode, 200)
  const turn = await terminalTurn(result)
  const replay = await sendConversation(server, secondDevice, requestId, question)
  assert.deepEqual(await terminalTurn(replay), turn)
  assert.equal(histories.length, 2)
  const followup = await sendConversation(server, secondDevice, randomUUID(), '先看写入规则')
  assert.equal(followup.statusCode, 200)
  assert.deepEqual(histories[2], [
    { role: 'user', content: question },
    { role: 'assistant', content: conversationContentText(turn.replyBlocks) },
    { role: 'user', content: '先看写入规则' },
  ])
  // The other app instance uses the same database, as after a process restart.
  assert.deepEqual(await readConversation(app, alice), [turn, await terminalTurn(followup)])
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
  const failed = await terminalTurn(await sendConversation(server, alice, requestId, question))
  assert.equal(failed.status, 'retryable')
  assert.equal((await readConversation(app, alice)).at(-1)?.status, 'retryable')
  const retry = sendConversation(server, alice, requestId, question)
  await started
  await pool.query("UPDATE conversation_turns SET lease_until = now() - interval '1 second' WHERE request_id = $1", [requestId])
  assert.equal((await readConversation(server, alice)).at(-1)?.status, 'retryable')
  const recovered = await terminalTurn(await sendConversation(server, alice, requestId, question))
  assert.equal(recovered.status, 'complete')
  finishLate('过时的回复')
  assert.deepEqual(await terminalTurn(await retry), recovered)
  assert.equal(calls, 3)
  assert.deepEqual((await readConversation(server, alice)).filter(turn => turn.requestId === requestId), [recovered])
})

test('a new topic closes a failed attempt and repeated retries have a shared limit', async t => {
  const bob = await login('bob@example.test')
  const requestId = randomUUID()
  const nextId = randomUUID()
  let calls = 0
  const server = createApp(pool, async () => { calls++; throw Error('offline') })
  t.after(() => server.close())
  const first = () => sendConversation(server, bob, requestId, '甲').then(terminalTurn)
  const next = () => sendConversation(server, bob, nextId, '乙').then(terminalTurn)
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
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const desktop = await login(user.email)
  const phone = await login(user.email)
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
  const generating = sendConversation(server, desktop, requestId, question)
  await started
  const stop = (cookie: string, id: string = requestId) => server.inject({ method: 'POST', url: `/api/conversation/${id}/stop`, headers: { cookie } })
  try {
    assert.equal((await stop(other)).statusCode, 404)
    assert.equal(signal.aborted, false)
    const stopped: ConversationTurn = { requestId, kind: 'user', messageText: question, status: 'stopped', replyBlocks: null }
    assert.deepEqual((await stop(phone)).json(), { turn: stopped })
    assert.equal(signal.aborted, true)
    assert.deepEqual((await stop(desktop)).json(), { turn: stopped })
    assert.deepEqual(await readConversation(app, phone), [stopped])
    finish()
    assert.deepEqual(await terminalTurn(await generating), stopped)
    assert.deepEqual(await terminalTurn(await sendConversation(server, desktop, requestId, question)), stopped)
    const next = await terminalTurn(await sendConversation(server, phone, randomUUID(), '下一条消息'))
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
  const conversation = (cookie: string, payload: { requestId: string; messageText: string; expectedRevision: number }) =>
    app.inject({ method: 'POST', url: path + '/conversation', headers: { cookie }, payload })
  const log = (cookie: string) => app.inject({ url: path + '/conversation', headers: { cookie } })
  const historyBefore = await readConversation(app, desktop)
  const guess = { requestId: randomUUID(), expectedRevision: initial.revision, messageText: '先不要提示，我猜同伴是另一个目击者。' }
  const response = await conversation(desktop, guess)
  assert.equal(response.statusCode, 200)
  const turn = response.json().turn
  assert.equal(turn.messageText, guess.messageText)
  assert.equal(turn.status, 'complete')
  assert.equal(turn.intent, 'message')
  assert.ok(turn.replyText)
  assert.ok(!turn.replyText.includes(memoirCourse.privateContent.hints[0]))
  assert.deepEqual((await conversation(phone, guess)).json().turn, turn)
  assert.deepEqual((await log(phone)).json().turns, [turn])
  assert.deepEqual(await readConversation(app, phone), historyBefore)
  assert.deepEqual(response.json().activity, initial)
  assert.equal((await log(other)).statusCode, 404)
  assert.equal((await conversation(other, guess)).statusCode, 404)

  const help = { ...guess, requestId: randomUUID(), messageText: '请给我一条提示。' }
  const firstHelp = await conversation(phone, help)
  assert.equal(firstHelp.statusCode, 200)
  const { activity: helped, turn: hintTurn } = firstHelp.json()
  assert.equal(hintTurn.intent, 'hint')
  assert.ok(hintTurn.replyText.includes(memoirCourse.privateContent.hints[0]))
  assert.deepEqual(helped.claimedHints, memoirCourse.privateContent.hints)
  assert.equal(helped.revision, initial.revision + 1)
  assert.deepEqual((await conversation(desktop, help)).json(), firstHelp.json())
  const hintCommand = { activityId, expectedRevision: initial.revision, commandId: help.requestId }
  const hint = (cookie: string, payload: typeof hintCommand) => app.inject({
    method: 'POST', url: path + '/hints', headers: { cookie }, payload,
  })
  const replay = await hint(desktop, hintCommand)
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.json().hintText, memoirCourse.privateContent.hints[0])
  assert.deepEqual(replay.json().activity, helped)
  assert.deepEqual((await log(desktop)).json().turns, [turn, hintTurn])
  assert.equal((await hint(other, hintCommand)).statusCode, 404)
  assert.equal((await hint(desktop, { ...hintCommand, expectedRevision: helped.revision })).statusCode, 409)
  assert.equal((await hint(desktop, { ...hintCommand, commandId: randomUUID(), expectedRevision: helped.revision })).statusCode, 409)

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
  const payload = { activityId, commandId: randomUUID(), expectedRevision: initial.revision }
  const [first, second] = await raceActivityRequests(activityId, () => Promise.all([phone, desktop].map(cookie =>
    app.inject({ method: 'POST', url: path + '/hints', headers: { cookie }, payload }))))
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.deepEqual(second.json(), first.json())
  const current = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: desktop } })).json())
  assert.deepEqual(current, first.json().activity)
  assert.equal(current.revision, initial.revision + 1)
  assert.deepEqual(current.claimedHints, [first.json().hintText])
  assert.deepEqual(current.claimedHints, memoirCourse.privateContent.hints)
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
    payload: { activityId, commandId: randomUUID(), expectedRevision: initial.revision },
  }))))
  assert.deepEqual(results.map(response => response.statusCode).sort(), [200, 409])
  const current = ActivityViewSchema.parse((await app.inject({ url: path, headers: { cookie: phone } })).json())
  assert.ok(results.every(response => response.json().activity.revision === current.revision))
  assert.equal(current.revision, initial.revision + 1)
  assert.deepEqual(current.claimedHints, memoirCourse.privateContent.hints)
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
    method: 'POST', url: '/api/activities/' + target.activityId + '/conversation', headers: { cookie },
    payload: { requestId: randomUUID(), expectedRevision: 1, messageText: text },
  })
  const guess = '不要提示，我猜作者只看到了石阶上的灯。'
  assert.equal((await send(first, desktop, guess)).json().turn.intent, 'message')
  assert.equal((await send(separate, desktop, '我在另一道练习有不同想法。')).statusCode, 200)
  const recall = (await send(first, phone, '我刚才说了什么？')).json()
  assert.equal(recall.turn.replyText, '你在这项活动的上一条消息里写道：“' + guess + '”')
  assert.equal((await send(first, phone, '摘录是什么意思？')).json().turn.replyText, memoirCourse.publicContent.clarifications[0].text)
  const followup = (await send(first, desktop, '同伴说的是哪一处？')).json()
  assert.match(followup.turn.replyText, /给我一条提示/u)
  assert.ok(!followup.turn.replyText.includes(memoirCourse.privateContent.hints[0]!))
  const quoted = (await send(first, desktop, '如果我说“请给我一条提示”，会发生什么？')).json()
  assert.equal(quoted.turn.intent, 'message')
  assert.deepEqual(quoted.activity.claimedHints, [])
  const help = (await send(first, phone, '能给我点线索吗？')).json()
  assert.equal(help.turn.intent, 'hint')
  assert.equal(help.turn.replyText, memoirCourse.privateContent.hints[0])
})

test('activity conversation recovers a received request after hint publication fails and a different device retries', async t => {
  const { activityId } = await createTestActivity(pool)
  t.after(() => removeTestActivity(pool, activityId))
  const phone = await login()
  const desktop = await login()
  const path = '/api/activities/' + activityId + '/conversation'
  const command = { expectedRevision: 1, requestId: randomUUID(), messageText: '领取提示' }
  const post = (cookie: string, payload = command) => app.inject({ method: 'POST', url: path, headers: { cookie }, payload })
  await pool.query("ALTER TABLE activity_conversation_turns ADD CONSTRAINT test_stop_reply CHECK (status = 'pending') NOT VALID")
  try {
    assert.equal((await post(phone)).statusCode, 500)
    const saved = await app.inject({ url: path, headers: { cookie: desktop } })
    assert.equal(saved.statusCode, 200)
    const snapshot = saved.json()
    assert.deepEqual(snapshot.turns, [{ ...command, intent: 'hint', status: 'pending', replyText: null }])
    assert.deepEqual(snapshot.activity.claimedHints, [])
    assert.equal(snapshot.activity.revision, 1)
    assert.equal((await post(desktop, { ...command, requestId: randomUUID(), messageText: '下一条消息' })).statusCode, 409)
  } finally {
    await pool.query('ALTER TABLE activity_conversation_turns DROP CONSTRAINT test_stop_reply')
  }
  const recovered = await post(desktop)
  assert.equal(recovered.statusCode, 200)
  const result = recovered.json()
  assert.equal(result.turn.status, 'complete')
  assert.deepEqual(result.activity.claimedHints, [memoirCourse.privateContent.hints[0]])
  assert.equal(result.activity.revision, 2)
  assert.deepEqual((await post(phone)).json(), result)
})

test('published material supports cited follow-ups and one shared activity across devices', async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const desktop = await login(user.email)
  const phone = await login(user.email)
  const other = await login('bob@example.test')
  const server = createApp(pool, null)
  t.after(() => server.close())
  const list = await server.inject({ url: '/api/conversation/materials', headers: { cookie: desktop } })
  assert.equal(list.statusCode, 200)
  const options: ConversationMaterialOption[] = list.json().materials
  assert.equal(options.length, 1)
  const [source] = options
  assert.deepEqual(Object.keys(source).sort(), ['discussionVersion', 'question', 'sources', 'supplements', 'title'])
  const send = (cookie: string, requestId: string, text: string, materialSelection: ConversationMaterialSelection) =>
    server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { conversationId, requestId, messageText: text, materialSelection } })
  const start = (cookie: string, id: string) =>
    server.inject({ method: 'POST', url: '/api/conversation/' + id + '/activity', headers: { cookie } })

  const first = await terminalTurn(await send(desktop, randomUUID(), source.question, { discussionVersion: source.discussionVersion }))
  assert.equal(first.status, 'complete')
  assert.deepEqual(first.materialContext?.sources, source.sources)
  assert.ok(conversationCitations(first.replyBlocks).length)
  const extra = source.supplements[0]
  assert.ok(!JSON.stringify(first).includes(extra.text))
  const last = await terminalTurn(await send(phone, randomUUID(), source.question, {
    parentRequestId: first.requestId, discussionVersion: source.discussionVersion, sourceIds: [extra.id],
  }))
  assert.equal(last.materialContext?.discussionId, first.materialContext?.discussionId)
  assert.notEqual(conversationContentText(first.replyBlocks), conversationContentText(last.replyBlocks))
  assert.ok(conversationCitations(last.replyBlocks).some(citation => citation.sourceId === extra.id))
  for (const turn of [first, last]) {
    for (const citation of conversationCitations(turn.replyBlocks)) {
      assert.ok(citation.quote.trim())
      assert.ok(turn.materialContext?.sources.some(item => item.id === citation.sourceId && item.text.includes(citation.quote)))
    }
  }
  assert.equal((await pool.query('SELECT 1 FROM activities WHERE user_id = $1', [user.id])).rowCount, 0)

  assert.equal((await start(other, last.requestId)).statusCode, 404)
  const [a, b] = await Promise.all([start(phone, last.requestId), start(desktop, last.requestId)])
  assert.equal(a.statusCode, 200, a.payload)
  assert.deepEqual(b.json(), a.json())
  const { activityId } = a.json()
  assert.deepEqual((await pool.query('SELECT id FROM activities WHERE user_id = $1', [user.id])).rows, [{ id: activityId }])
  const path = '/api/activities/' + activityId
  const current = ActivityViewSchema.parse((await server.inject({ url: path, headers: { cookie: desktop } })).json())
  assert.equal(current.courseVersion, memoirCourse.version)
  assert.equal(current.title, memoirCourse.publicContent.title)
  assert.deepEqual(current.clarifications, memoirCourse.publicContent.clarifications)
  const history = await server.inject({ url: path + '/conversation', headers: { cookie: phone } })
  assert.equal(history.statusCode, 200)
  assert.deepEqual(history.json().origin.turns.map((turn: ConversationTurn) => turn.requestId), [first.requestId, last.requestId])

  assert.deepEqual(history.json().activity, current)
  assert.deepEqual(history.json().turns, [])
  assert.deepEqual(await readConversation(server, phone), [first, last])
  assert.deepEqual(current.allowedActions, ['view', 'requestHint'])
})

test('a user can ask about their own source without a course and an invented citation never reaches the reply', async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const cookie = await login(user.email)
  const fabricated = '花园里有四十座喷泉'
  let attempts = 0
  const server = createApp(pool, async ({ format }) => {
    assert.equal(format, 'json')
    attempts++
    return {
      kind: 'text',
      text: JSON.stringify({ blocks: [{ kind: 'text', text: fabricated, citations: [{ sourceId: 'invented-source', quote: fabricated }] }] }),
    }
  })
  t.after(() => server.close())
  const excerpt = { label: '值班记录（合成）', text: '周一傍晚，值班员在西侧温室数到三盆开花的兰花。' }
  const command = { conversationId, requestId: randomUUID(), messageText: '记录中的观察发生在什么时候？', materialSelection: { excerpt } }
  const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie }, payload: command })
  assert.equal(response.statusCode, 200, response.payload)
  const turn = await terminalTurn(response)
  assert.equal(attempts, 1)
  assert.equal(turn.explanationSource, 'excerpt')
  assert.equal(turn.materialContext?.discussionVersion, null)
  assert.ok(conversationCitations(turn.replyBlocks).some(c => c.label === excerpt.label && c.quote.trim() && excerpt.text.includes(c.quote)))
  assert.ok(!response.payload.includes(fabricated))
  assert.deepEqual((await readConversation(server, cookie)).at(-1), turn)
  assert.equal((await pool.query('SELECT 1 FROM activities WHERE user_id = $1', [user.id])).rowCount, 0)
  const cannotStart = await server.inject({ method: 'POST', url: '/api/conversation/' + turn.requestId + '/activity', headers: { cookie } })
  assert.ok(cannotStart.statusCode >= 400 && cannotStart.statusCode < 500)
})

test('a long discussion reads selected evidence across model calls and publishes one reply', async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const desktop = await login(user.email)
  const phone = await login(user.email)
  const rootRequestId = randomUUID()
  const requestId = randomUUID()
  const background = { label: '背景记录', text: '背景'.repeat(1050) + '。' }
  const quote = '设备在 09:05 完成校准。'
  const calibration = { label: '校准记录', text: quote + '同批'.repeat(1050) + '。' }
  const root = await app.inject({
    method: 'POST', url: '/api/conversation', headers: { cookie: desktop },
    payload: { conversationId, requestId: rootRequestId, messageText: '我想了解这项试验。', materialSelection: { excerpt: background } },
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
    env: { MODEL_API_KEY: 'test-credential', MODEL_BASE_URL: 'https://model.example.test/v1/' },
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
      const text = JSON.stringify({ blocks: [{ kind: 'text', text: '校准完成时间是 09:05。', citations: [{ sourceId: source.id, quote }] }] })
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: text } }] })
    },
  }))
  t.after(() => { releaseFinalCall(); return server.close() })

  const question = '设备什么时候完成校准？'
  const received = server.inject({
    method: 'POST', url: '/api/conversation', headers: { cookie: desktop },
    payload: { conversationId, requestId, messageText: question, materialSelection: { parentRequestId: rootRequestId, excerpt: calibration } },
  })
  await Promise.race([finalCall, received.then(response =>
    assert.fail(`Expected the final model call, got HTTP ${response.statusCode} after ${calls} calls`))])
  try {
    const pending = (await readConversation(server, phone)).at(-1)
    assert.equal(pending?.requestId, requestId)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.replyBlocks, null)
    assert.deepEqual(await terminalTurn(await sendConversation(server, phone, requestId, question)), pending)
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
  assert.equal(turn.explanationSource, 'model')
  assert.equal(conversationContentText(turn.replyBlocks), '校准完成时间是 09:05。')
  assert.deepEqual(conversationCitations(turn.replyBlocks), [{ sourceId: source.id, label: source.label, quote }])
  assert.deepEqual((await readConversation(server, phone)).filter(item => item.requestId === requestId), [turn])
  assert.deepEqual(await terminalTurn(await sendConversation(server, phone, requestId, question)), turn)
  assert.equal(calls, 3)
})

test('conversation uses user-provided excerpts and does not attach private activity material', async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const cookie = await login(user.email)
  const created = await inTransaction(pool, db => createActivity(db, user.id, memoirCourse.version))
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
      blocks: [{ kind: 'excerpt', source: { sourceId: prompt.sources[0].id, quote } }],
    }) }
  })
  t.after(() => server.close())

  assert.equal((await terminalTurn(await sendConversation(server, cookie, randomUUID(), '怎么读回忆录？'))).status, 'complete')
  const reply = await terminalTurn(await server.inject({
    method: 'POST', url: '/api/conversation', headers: { cookie },
    payload: { conversationId, requestId: randomUUID(), messageText: '这段记录说了什么？', materialSelection: { excerpt: { label: '阅读笔记', text: quote } } },
  }))
  assert.equal(reply.explanationSource, 'model')
  assert.equal(conversationCitations(reply.replyBlocks)[0].quote, quote)
})

test('memory authorization also fences inherited history, buffered output and replay across devices', { timeout: 10_000 }, async t => {
  const owner = await createTestUser(pool)
  t.after(() => removeTestUser(pool, owner.id))
  const desktop = await login(owner.email)
  const phone = await login(owner.email)
  const other = await login('bob@example.test')
  const secret = '用星座卡片逐步练习'
  const details = { kind: 'statement', body: secret, topic: '星图', expiresAt: null, authorizedForTutoring: true }
  const create = { ...details, operation: 'remember', commandId: randomUUID() }
  const change = (cookie: string, payload: object) => app.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie }, payload })
  const list = (cookie: string) => app.inject({ url: '/api/personal-memories', headers: { cookie } })
  const first = await change(desktop, create)
  assert.equal(first.statusCode, 200, first.payload)
  assert.deepEqual((await change(phone, create)).json(), first.json())
  assert.equal((await change(phone, { ...create, body: '另一条记忆' })).statusCode, 409)
  assert.deepEqual((await list(other)).json(), emptyMemories)

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

  const seen = await terminalTurn(await sendConversation(server, desktop, randomUUID(), '星图入门'))
  assert.equal(conversationContentText(seen.replyBlocks), secret)
  const sourceUrl = '/api/personal-memories/source/' + seen.requestId
  const source = await app.inject({ url: sourceUrl, headers: { cookie: desktop } })
  assert.equal(source.statusCode, 200)
  assert.deepEqual(source.json(), { messageText: '星图入门' })
  assert.equal((await app.inject({ url: sourceUrl, headers: { cookie: other } })).statusCode, 404)
  assert.equal((await change(other, { ...create, commandId: randomUUID(), sourceRequestId: seen.requestId })).statusCode, 400)
  await sendConversation(server, desktop, randomUUID(), '研究月球')
  assert.ok(!inputs.at(-1)?.includes(secret), 'derived history must honor the same topic restriction')

  const requestId = randomUUID()
  const pending = sendConversation(server, desktop, requestId, '星图进阶')
  await blocked
  const revision = first.json().memories[0].revision
  const revoke = { ...details, operation: 'correct', commandId: randomUUID(), id: create.commandId, expectedRevision: revision, authorizedForTutoring: false }
  const updated = await change(phone, revoke)
  release()
  assert.equal(updated.statusCode, 200, updated.payload)
  assert.equal((await change(desktop, { ...create, body: '另一个从未保存的内容' })).statusCode, 409)
  const stale = await pending
  assert.ok(!stale.payload.includes(secret))
  assert.equal((await terminalTurn(stale)).status, 'retryable')
  assert.equal(logs.records().find(item => item.event === 'publish' && item.requestId === requestId).outcome, 'memory_invalidated')
  assert.ok(!logs.raw().includes(secret))
  const recovered = await terminalTurn(await sendConversation(server, phone, requestId, '星图进阶'))
  assert.equal(recovered.status, 'complete')
  assert.ok(!inputs.at(-1)?.includes(secret))
  const expired = (await readConversation(server, phone)).find(turn => turn.requestId === seen.requestId)
  assert.equal(expired?.kind, 'user')
  assert.deepEqual(expired.replyBlocks, [{ kind: 'unavailable', id: seen.replyBlocks![0].id }])
  assert.equal((await change(desktop, { ...revoke, commandId: randomUUID() })).statusCode, 409)

  const forget = { operation: 'forget', commandId: randomUUID(), id: create.commandId, expectedRevision: updated.json().memories[0].revision }
  assert.deepEqual((await change(phone, forget)).json(), emptyMemories)
  assert.deepEqual((await change(desktop, forget)).json(), emptyMemories)
  assert.equal((await change(desktop, { ...forget, expectedRevision: forget.expectedRevision + 1 })).statusCode, 409)
  assert.deepEqual((await change(desktop, create)).json(), emptyMemories)
  assert.equal((await pool.query('SELECT body FROM personal_memories WHERE user_id = $1', [owner.id])).rows[0].body, null)
})

test('a summary can reclaim an expired job, stays in its branch and discards obsolete results', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const phone = await login(user.email)
  const desktop = await login(user.email)
  const inputs: { history: unknown; memory?: string }[] = []
  const excerpt = { label: '记录', text: '馆藏在周一登记。' }
  const root = randomUUID()
  const sourceId = 'excerpt:' + root
  const server = createApp(pool, async ({ messages }) => {
    inputs.push(JSON.parse(messages[0].content!))
    return { kind: 'text', text: JSON.stringify({
      blocks: [{ kind: 'text', text: '可以对照登记记录。', citations: [{ sourceId: sourceId, quote: excerpt.text }] }],
    }) }
  })
  t.after(() => server.close())
  const send = (cookie: string, requestId: string, text: string, materialSelection: ConversationMaterialSelection) =>
    server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { conversationId, requestId, messageText: text, materialSelection } }).then(terminalTurn)

  await send(desktop, root, '看看馆藏记录', { excerpt })
  let parent = root
  for (let index = 1; index <= 22; index++) {
    const id = randomUUID()
    assert.equal((await send(desktop, id, '甲分支问题 ' + index, { parentRequestId: parent })).status, 'complete')
    parent = id
  }
  await pool.query(`
    UPDATE conversation_summaries SET attempt = 1, lease_until = clock_timestamp() - interval '1 second' WHERE user_id = $1
  `, [user.id])
  const summarize: ModelClient = async ({ messages }) => {
    const rows = JSON.parse(messages[0].content!)
    const last = rows.at(-1)
    return { kind: 'text', text: JSON.stringify({ notes: [{ kind: 'question', sourceRequestId: last.requestId, quote: last.messageText }] }) }
  }
  const config = async () => ({ model: summarize, settings: defaultAgentSettings })
  assert.equal(await processNextSummary(pool, config), true)
  assert.equal(await processNextSummary(pool, config), true)
  const remaining = await pool.query('SELECT attempt, status FROM conversation_summaries WHERE user_id = $1', [user.id])
  assert.deepEqual(remaining.rows, [{ attempt: 2, status: 'complete' }, { attempt: 2, status: 'complete' }])

  await send(phone, randomUUID(), '乙分支的问题', { parentRequestId: root })
  assert.equal(inputs.at(-1)?.memory, undefined)
  await send(phone, randomUUID(), '接续甲分支', { parentRequestId: parent })
  assert.match(inputs.at(-1)?.memory ?? '', /甲分支问题 1"/)
  assert.ok(!JSON.stringify(inputs.at(-1)?.history).includes('甲分支问题 1"'))

  const memoryId = randomUUID()
  const change = (payload: object) => app.inject({ method: 'POST', url: '/api/personal-memories', headers: { cookie: phone }, payload })
  const record = { kind: 'wish', body: '了解馆藏档案', authorizedForTutoring: true, topic: '', expiresAt: null }
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
    id: memoryId, expectedRevision: 1, body: '了解登记日期' })
  finish()
  assert.equal(correction.statusCode, 200, correction.payload)
  assert.equal(await work, true)
  assert.equal((await pool.query("SELECT 1 FROM conversation_summaries WHERE user_id = $1 AND summary IS NOT NULL", [user.id])).rowCount, 0)
})
