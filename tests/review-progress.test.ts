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
const notes = { label: '锋面笔记', text: '冷锋过境时气温下降、气压上升，常伴随短时降水。' }
const quote = '冷锋过境时气温下降、气压上升'

test('a recalled review answer in a goal conversation proposes progress for that goal, and nothing else does', { timeout: 20_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let time = new Date('2026-11-28T08:00:00Z').getTime()
  const answers: MaterialPrompt[] = []
  // Each conversation's answer is judged by the word it contains.
  const model: ModelClient = async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(String(messages.at(-1)!.content))
    const sourceId = prompt.sources[0]!.id
    const blocks = [{ kind: 'text', text: '对照原文看。', citations: [{ sourceId, quote }] }]
    if (!prompt.review) return { kind: 'text', text: JSON.stringify({ blocks,
      review: { topic: '冷锋过境', question: '冷锋过境时气温和气压怎么变？', answer: '气温下降、气压上升。', afterDays: 2, sourceId, quote } }) }
    answers.push(prompt)
    const result = prompt.question.includes('大概') ? 'partial' : 'recalled'
    return { kind: 'text', text: JSON.stringify({ blocks, reviewAnswered: true, reviewOutcome: { result, note: '你说出了要点。' },
      goalProgress: '我能说出冷锋过境时气温下降、气压上升' }) }
  }
  const server = createApp(pool, model, undefined, undefined, { reviewNow: () => new Date(time) })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const post = (url: string, payload: object) => server.inject({ method: 'POST', url, headers: { cookie }, payload })
  const send = async (conversationId: string, messageText: string, extra: object = {}) => {
    const response = await post('/api/conversation', { conversationId, requestId: randomUUID(), messageText, ...extra })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const goalId = randomUUID()
  await post('/api/learning-goals/commands', { operation: 'create', commandId: goalId, title: '看懂天气图', motivation: '登山', progress: '认识了等压线', status: 'active' })

  // A user has one pending review at a time, so each case discusses, waits until the review is due and answers it.
  const reviewed = async (inGoal: boolean, text: string) => {
    const conversationId = randomUUID()
    await send(conversationId, '冷锋过境会怎样？', { materialSelection: { excerpt: notes } })
    if (inGoal) await post(`/api/conversations/${conversationId}/commands`, { operation: 'set_goal', commandId: randomUUID(), goalId })
    time += 49 * 3_600_000
    const snapshot = (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>()
    const reviewInvitationId = snapshot.reviewInvitation!.reviewInvitationId
    await post('/api/conversation/review-invitations', { conversationId, action: 'accept', reviewInvitationId, commandId: randomUUID() })
    return send(conversationId, text, { reviewInvitationId })
  }

  const full = await reviewed(true, '气温下降，气压上升。')
  assert.deepEqual(answers[0]!.currentGoal, { title: '看懂天气图', motivation: '登山', progress: '认识了等压线' }, 'the review sees its conversation goal')
  const proposal = full.replyBlocks!.at(-1)
  assert.ok(proposal?.kind === 'goal_progress_proposal', 'the proposal follows the feedback')
  assert.deepEqual([proposal.goalId, proposal.progress], [goalId, '我能说出冷锋过境时气温下降、气压上升'])

  const half = await reviewed(true, '大概是降温吧。')
  assert.ok(!half.replyBlocks!.some(block => block.kind === 'goal_progress_proposal'), 'a partial answer proposes nothing')

  const none = await reviewed(false, '气温下降，气压上升。')
  assert.equal(answers[2]!.currentGoal, undefined, 'a conversation outside any goal sends none')
  assert.ok(!none.replyBlocks!.some(block => block.kind === 'goal_progress_proposal'))
})
