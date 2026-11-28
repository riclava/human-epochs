import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot } from '../src/contracts/conversation.js'
import type { LearningRecord } from '../src/contracts/learning.js'
import type { LearningGoalList } from '../src/contracts/learning-goal.js'
import type { MaterialPrompt, ModelClient } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const notes = { label: '锋面笔记', text: '冷锋过境时气温下降、气压上升，常伴随短时降水。' }
const quote = '冷锋过境时气温下降、气压上升'

test('conversations belong to goals, which collect their reviews, and the Agent proposes progress for the goal', { timeout: 20_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const inputs: string[] = []
  const model: ModelClient = async ({ messages }) => {
    const last = String(messages.at(-1)!.content)
    if (last.startsWith('{')) {
      const prompt: MaterialPrompt = JSON.parse(last)
      const sourceId = prompt.sources[0]!.id
      return { kind: 'text', text: JSON.stringify({
        blocks: [{ kind: 'text', text: '冷锋过境后会降温。', citations: [{ sourceId, quote }] }],
        review: { topic: '冷锋过境', question: '冷锋过境时气温怎么变？', answer: '下降。', afterDays: 2, sourceId, quote },
      }) }
    }
    inputs.push(JSON.stringify(messages))
    return { kind: 'text', text: '对，你说得没错。\n\n```goal_progress\n{"progress":"我能说出冷锋过境时气温和气压的变化","goalId":"00000000-0000-4000-8000-000000000000"}\n```' }
  }
  const server = createApp(pool, model)
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const send = async (conversationId: string, messageText: string, materialSelection?: object) => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
      payload: { conversationId, requestId: randomUUID(), messageText, ...(materialSelection ? { materialSelection } : {}) } })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const command = (conversationId: string, payload: object, asCookie = cookie) => server.inject({ method: 'POST',
    url: `/api/conversations/${conversationId}/commands`, headers: { cookie: asCookie }, payload: { commandId: randomUUID(), ...payload } })
  const goals = async () => (await server.inject({ url: '/api/learning-goals', headers: { cookie } })).json<LearningGoalList>().goals
  const snapshot = async (conversationId: string) => (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>()
  const goalId = randomUUID()
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'create', commandId: goalId, title: '看懂天气图', motivation: '登山', progress: '认识了等压线', status: 'active' } })

  // A discussion with a review, and an ordinary conversation, both put under the goal.
  const discussion = randomUUID()
  await send(discussion, '冷锋过境会怎样？', { excerpt: notes })
  const chat = randomUUID()
  const outside = await send(chat, '冷锋过境时气温和气压怎么变？')
  assert.ok(!outside.replyBlocks!.some(block => block.kind === 'goal_progress_proposal'), 'no goal, no progress proposal')
  assert.ok(!inputs[0]!.includes('currentGoal'))
  assert.equal((await command(discussion, { operation: 'set_goal', goalId: randomUUID() })).statusCode, 404, 'only an existing goal')
  const bob = await login(server, 'bob@example.test')
  assert.equal((await command(discussion, { operation: 'set_goal', goalId }, bob)).statusCode, 404, 'only the owner')
  for (const conversationId of [discussion, chat]) assert.equal((await command(conversationId, { operation: 'set_goal', goalId })).statusCode, 200)
  assert.equal((await snapshot(chat)).goalId, goalId)

  const inside = await send(chat, '所以冷锋过境后气温下降、气压上升，对吗？')
  const reference = JSON.parse(JSON.parse(inputs[1]!)[0].content.replace(/^[^{]*/u, ''))
  assert.deepEqual(reference.currentGoal, { title: '看懂天气图', motivation: '登山', progress: '认识了等压线' }, 'the conversation goal is marked')
  assert.deepEqual(reference.goals, [], 'and not repeated')
  const progress = inside.replyBlocks!.find(block => block.kind === 'goal_progress_proposal')
  assert.ok(progress?.kind === 'goal_progress_proposal')
  assert.deepEqual([progress.goalId, progress.progress], [goalId, '我能说出冷锋过境时气温和气压的变化'], 'the goal comes from the conversation, not the model')

  await pool.query(`UPDATE review_invitations SET due_at = now() - interval '1 hour' WHERE user_id = $1`, [user.id])
  let [goal] = await goals()
  assert.deepEqual({ ...goal!.activity, conversations: goal!.activity.conversations.map(item => [item.id, item.reviewDue]) }, {
    conversationCount: 2, reviewTopics: 1, dueReviews: 1, latestResult: null,
    conversations: [[chat, false], [discussion, true]],
  })
  const { rows: [invitation] } = await pool.query('SELECT id FROM review_invitations WHERE user_id = $1', [user.id])
  const answer = await send(discussion, '下降。')
  await pool.query(`INSERT INTO review_attempts (user_id, request_id, review_invitation_id, outcome, note, answered_at)
    VALUES ($1, $2, $3, 'recalled', '答对了', now())`, [user.id, answer.requestId, invitation.id])
  ;[goal] = await goals()
  assert.equal(goal!.activity.latestResult, 'recalled')
  const record = (await server.inject({ url: '/api/learning-record', headers: { cookie } })).json<LearningRecord>()
  assert.deepEqual(record.topics.map(topic => [topic.topic, topic.goalId]), [['冷锋过境', goalId]])

  // A paused goal is not offered for progress, and deleting a goal releases its conversations.
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'update', commandId: randomUUID(), id: goalId, expectedRevision: 1, title: '看懂天气图', motivation: '登山', progress: '认识了等压线', status: 'paused' } })
  const paused = await send(chat, '暖锋呢？')
  assert.ok(!paused.replyBlocks!.some(block => block.kind === 'goal_progress_proposal'))
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'delete', commandId: randomUUID(), id: goalId, expectedRevision: 2 } })
  assert.equal((await snapshot(chat)).goalId, null)
  assert.equal((await snapshot(chat)).turns.length, 3, 'the conversation stays')
  assert.equal((await command(chat, { operation: 'set_goal', goalId: null })).statusCode, 200)
})

test('accepting a proposal puts its conversation under the new goal unless it already has one', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, async () => ({ kind: 'text', text: '好的。\n\n```goal\n{"title":"学会弹吉他"}\n```' }))
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const conversationId = randomUUID()
  const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
    payload: { conversationId, requestId: randomUUID(), messageText: '我想学会弹吉他。' } })
  const turn = await readConversationTurn(response.payload, String(response.headers['content-type']))
  const block = turn.replyBlocks!.find(item => item.kind === 'goal_proposal')!
  const goalId = randomUUID()
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'create', commandId: goalId, title: '学会弹吉他', motivation: '', progress: '', status: 'active', proposal: { requestId: turn.requestId, blockId: block.id } } })
  const snapshot = (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>()
  assert.equal(snapshot.goalId, goalId)

  const other = randomUUID()
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'create', commandId: other, title: '乐理', motivation: '', progress: '', status: 'active' } })
  await server.inject({ method: 'POST', url: `/api/conversations/${conversationId}/commands`, headers: { cookie }, payload: { operation: 'set_goal', commandId: randomUUID(), goalId: other } })
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'delete', commandId: randomUUID(), id: goalId, expectedRevision: 1 } })
  await server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie }, payload: {
    operation: 'create', commandId: randomUUID(), title: '学会弹吉他', motivation: '', progress: '', status: 'active', proposal: { requestId: turn.requestId, blockId: block.id } } })
  assert.equal((await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie } })).json<ConversationSnapshot>().goalId, other,
    'a conversation that already has a goal keeps it')
})
