import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot } from '../src/contracts/conversation.js'
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
