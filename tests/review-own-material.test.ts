import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot } from '../src/contracts/conversation.js'
import type { LearningRecord } from '../src/contracts/learning.js'
import type { MaterialPrompt, ModelClient } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()

const rules = { label: '实验室安全规程', text: '离心结束后等待转子完全停止再开盖取出样品。配平误差超过 0.1 克时重新配平。' }
const question = '离心结束后什么时候可以开盖？'
const answer = '等转子完全停止之后。'

test('a discussion of the user\'s own material can be reviewed later in any conversation', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let time = new Date('2026-12-01T08:00:00Z').getTime()
  const prompts: MaterialPrompt[] = []
  let quote = '离心结束后等待转子完全停止再开盖取出样品。'
  const model: ModelClient = async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(messages.at(-1)!.content!)
    prompts.push(prompt)
    const sourceId = prompt.sources[0]!.id
    const citations = [{ sourceId, quote: rules.text.slice(0, 21) }]
    const result = prompt.review
      ? { blocks: [{ kind: 'text', text: '对，要等转子停稳。', citations }], reviewAnswered: true }
      : { blocks: [{ kind: 'text', text: '规程要求停稳后开盖。', citations }],
        review: { topic: '离心机开盖时机', question, answer, afterDays: 2, sourceId, quote } }
    return { kind: 'text', text: JSON.stringify(result) }
  }
  const server = createApp(pool, model, undefined, undefined, { reviewNow: () => new Date(time) })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const send = (conversationId: string, messageText: string, extra: object = {}) => server.inject({
    method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { conversationId, requestId: randomUUID(), messageText, ...extra },
  }).then(response => readConversationTurn(response.payload, String(response.headers['content-type'])))
  const snapshot = async (conversationId: string) =>
    (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>()

  const lab = randomUUID()
  const first = await send(lab, '离心机什么时候能开盖？', { materialSelection: { excerpt: rules } })
  assert.equal(first.explanationSource, 'model')
  assert.equal(prompts[0]!.offerReview, true, 'the user\'s own material is offered for review')
  assert.equal((await snapshot(lab)).reviewInvitation, undefined, 'the review waits until it is due')

  time += 2 * 86_400_000
  const elsewhere = randomUUID()
  const invitation = (await snapshot(elsewhere)).reviewInvitation!
  assert.deepEqual({ ...invitation, reviewInvitationId: undefined },
    { reviewInvitationId: undefined, topic: '离心机开盖时机', sourceLabel: '实验室安全规程', conversationTitle: '离心机什么时候能开盖？' })

  const accepted = await server.inject({ method: 'POST', url: '/api/conversation/review-invitations', headers: { cookie },
    payload: { conversationId: elsewhere, commandId: randomUUID(), reviewInvitationId: invitation.reviewInvitationId, action: 'accept' } })
  assert.equal(accepted.statusCode, 200, accepted.payload)
  const reviewTurn = accepted.json<ConversationSnapshot>().turns.at(-1)!
  assert.equal(reviewTurn.kind, 'review_question')
  assert.deepEqual((await snapshot(lab)).turns.map(turn => turn.kind), ['user'], 'the question goes to the conversation that accepted it')

  const feedback = await send(elsewhere, answer, { reviewInvitationId: invitation.reviewInvitationId })
  assert.equal(feedback.status, 'complete')
  assert.deepEqual(prompts.at(-1)!.review, { question, answer })
  assert.deepEqual(prompts.at(-1)!.sources.map(source => [source.label, source.text]), [[rules.label, rules.text]],
    'the answer is checked against the original material snapshot')

  quote = '规程里没有的句子。'
  const unsourced = randomUUID()
  await send(unsourced, '再讲讲配平', { materialSelection: { excerpt: rules } })
  time += 3 * 86_400_000
  assert.equal((await snapshot(unsourced)).reviewInvitation, undefined, 'a proposal quoting text outside the material is dropped')

  quote = '配平误差超过 0.1 克时重新配平。'
  const doomed = randomUUID()
  await send(doomed, '配平有什么要求？', { materialSelection: { excerpt: rules } })
  time += 3 * 86_400_000
  assert.ok((await snapshot(doomed)).reviewInvitation, 'a later discussion schedules its own review')
  const removed = await server.inject({ method: 'POST', url: `/api/conversations/${doomed}/commands`, headers: { cookie },
    payload: { operation: 'delete', commandId: randomUUID() } })
  assert.equal(removed.statusCode, 200, removed.payload)
  assert.equal((await snapshot(elsewhere)).reviewInvitation, undefined, 'deleting the source conversation retires its review')
})

test('answers record how well a point was recalled, set the next interval, and show in the learning record', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let time = new Date('2026-12-01T08:00:00Z').getTime()
  let outcome: object | undefined = { result: 'forgotten', note: '没有说出要等转子停稳。' }
  // Each review proposes a new wording, as a repeated question is not scheduled again.
  let rounds = 0
  const model: ModelClient = async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(messages.at(-1)!.content!)
    const sourceId = prompt.sources[0]!.id
    const citations = [{ sourceId, quote: rules.text.slice(0, 21) }]
    // The model asks for 30 days every time; the recorded result decides how far that is allowed to go.
    rounds++
    const review = { topic: '离心机开盖时机', question: prompt.review ? `换个说法（第 ${rounds} 次）：什么时候能开盖？` : question, answer, afterDays: 30, sourceId,
      quote: '离心结束后等待转子完全停止再开盖取出样品。' }
    const result = prompt.review
      // Feedback may quote the user's own answer back; that quote is checked against the message, not the sources.
      ? { blocks: [{ kind: 'text', text: `你说“${prompt.question}”。要等转子停稳。`, citations }], reviewAnswered: true, review, ...(outcome ? { reviewOutcome: outcome } : {}) }
      : { blocks: [{ kind: 'text', text: '规程要求停稳后开盖。', citations }], review }
    return { kind: 'text', text: JSON.stringify(result) }
  }
  const server = createApp(pool, model, undefined, undefined, { reviewNow: () => new Date(time) })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const conversationId = randomUUID()
  const send = (messageText: string, extra: object = {}) => server.inject({
    method: 'POST', url: '/api/conversation', headers: { cookie }, payload: { conversationId, requestId: randomUUID(), messageText, ...extra },
  }).then(response => readConversationTurn(response.payload, String(response.headers['content-type'])))
  const record = async () => (await server.inject({ url: '/api/learning-record', headers: { cookie } })).json<LearningRecord>()
  const accept = async () => {
    const invitation = (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>().reviewInvitation!
    const accepted = await server.inject({ method: 'POST', url: '/api/conversation/review-invitations', headers: { cookie },
      payload: { conversationId, commandId: randomUUID(), reviewInvitationId: invitation.reviewInvitationId, action: 'accept' } })
    assert.equal(accepted.statusCode, 200, accepted.payload)
    return invitation.reviewInvitationId
  }

  const origin = await send('离心机什么时候能开盖？', { materialSelection: { excerpt: rules } })
  assert.deepEqual((await record()).topics.map(topic => [topic.topic, topic.attempts.length, topic.nextReviewAt]),
    [['离心机开盖时机', 0, '2026-12-31T08:00:00.000Z']], 'the first proposal keeps the model\'s interval')

  time = Date.parse('2026-12-31T09:00:00Z')
  const firstReview = await accept()
  await send('我不记得了。', { reviewInvitationId: firstReview })
  let [topic] = (await record()).topics
  assert.deepEqual(topic!.attempts, [{ answeredAt: '2026-12-31T09:00:00.000Z', result: 'forgotten', note: '没有说出要等转子停稳。' }])
  assert.equal(topic!.nextReviewAt, '2027-01-02T09:00:00.000Z', 'a forgotten point comes back within two days')
  assert.equal(topic!.conversationId, conversationId)

  time = Date.parse('2027-01-02T10:00:00Z')
  outcome = { result: 'recalled', note: '说出了停稳后再开盖。' }
  await send(answer, { reviewInvitationId: await accept() })
  ;[topic] = (await record()).topics
  assert.deepEqual(topic!.attempts.map(attempt => attempt.result), ['forgotten', 'recalled'])
  assert.equal(topic!.nextReviewAt, '2027-02-01T10:00:00.000Z', 'a recalled point may wait the full proposal')

  const other = await login(server, 'bob@example.test')
  assert.ok(!(await server.inject({ url: '/api/learning-record', headers: { cookie: other } })).json<LearningRecord>().topics
    .some(item => item.originRequestId === origin.requestId), 'another user does not see this record')
  const command = (payload: object) => server.inject({ method: 'POST', url: '/api/learning-record/commands', headers: { cookie }, payload })
  assert.equal((await command({ operation: 'stop_topic', originRequestId: randomUUID() })).statusCode, 404)
  const stopped = await command({ operation: 'stop_topic', originRequestId: origin.requestId })
  assert.equal(stopped.statusCode, 200, stopped.payload)
  assert.deepEqual(stopped.json<LearningRecord>().topics.map(item => [item.stopped, item.nextReviewAt]), [[true, null]])
  assert.deepEqual((await command({ operation: 'stop_topic', originRequestId: origin.requestId })).json(), stopped.json(), 'stopping again changes nothing')
  time = Date.parse('2027-03-01T10:00:00Z')
  assert.equal((await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>().reviewInvitation,
    undefined, 'a stopped topic sends no more invitations')

  await pool.query('UPDATE users SET review_reminders_enabled = false WHERE id = $1', [user.id])
  assert.equal((await record()).remindersEnabled, false)
  assert.equal((await command({ operation: 'resume_reminders' })).json<LearningRecord>().remindersEnabled, true)
  outcome = undefined
})
