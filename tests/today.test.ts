import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot } from '../src/contracts/conversation.js'
import { hasTodayContent, type TodayView } from '../src/contracts/today.js'
import type { MaterialPrompt, ModelClient } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const notes = { label: '锋面笔记', text: '冷锋过境时气温下降、气压上升，常伴随短时降水。' }
const quote = '冷锋过境时气温下降、气压上升'

test('Today gathers the due review, active goals, open proposals and recent conversations', { timeout: 20_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let time = Date.now()
  const replies: string[] = []
  const model: ModelClient = async ({ messages }) => {
    const last = String(messages.at(-1)!.content)
    if (!last.startsWith('{')) return { kind: 'text', text: replies.shift() ?? '好的。' }
    const prompt: MaterialPrompt = JSON.parse(last)
    const sourceId = prompt.sources[0]!.id
    return { kind: 'text', text: JSON.stringify({ blocks: [{ kind: 'text', text: '看原文。', citations: [{ sourceId, quote }] }],
      review: { topic: '冷锋过境', question: '冷锋过境时气温怎么变？', answer: '下降。', afterDays: 2, sourceId, quote } }) }
  }
  const server = createApp(pool, model, undefined, undefined, { reviewNow: () => new Date(time) })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const today = async () => (await server.inject({ url: '/api/today', headers: { cookie } })).json<TodayView>()
  const post = (url: string, payload: object) => server.inject({ method: 'POST', url, headers: { cookie }, payload })
  const send = async (conversationId: string, messageText: string, extra: object = {}) => {
    const response = await post('/api/conversation', { conversationId, requestId: randomUUID(), messageText, ...extra })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const goalCommand = (payload: object) => post('/api/learning-goals/commands', { commandId: randomUUID(), motivation: '', progress: '', status: 'active', ...payload })

  const empty = await today()
  assert.deepEqual(empty, { review: null, goals: [], pending: [], recentConversations: [] })
  assert.equal(hasTodayContent(empty), false, 'a new user goes straight to a conversation')

  const goalId = randomUUID()
  await goalCommand({ operation: 'create', commandId: goalId, title: '看懂天气图', progress: '认识了等压线' })
  assert.deepEqual((await today()).goals, [{ id: goalId, title: '看懂天气图', progress: '认识了等压线', dueReviews: 0, latestResult: null, conversationId: null }])

  // "开始学" starts a conversation under the goal with its first message; another user's goal is ignored.
  const started = randomUUID()
  await send(started, '从哪里开始看天气图？', { goalId })
  const snapshot = async (id: string) => (await server.inject({ url: '/api/conversations/' + id, headers: { cookie } })).json<ConversationSnapshot>()
  assert.equal((await snapshot(started)).goalId, goalId)
  assert.equal((await today()).goals[0]!.conversationId, started)
  const stray = randomUUID()
  await send(stray, '随便聊聊', { goalId: randomUUID() })
  assert.equal((await snapshot(stray)).goalId, null)
  await send(stray, '再聊一句', { goalId })
  assert.equal((await snapshot(stray)).goalId, null, 'the goal counts only when the conversation is created')

  // Open proposals: a goal proposal and the newest progress proposal for an active goal.
  replies.push('```goal\n{"title":"学会弹吉他"}\n```', '```goal_progress\n{"progress":"我会读等压线"}\n```', '```goal_progress\n{"progress":"我会读等压线和锋面"}\n```')
  const proposed = await send(stray, '我想学会弹吉他。')
  await send(started, '我会读等压线了。')
  const newest = await send(started, '锋面符号也会了。')
  let pending = (await today()).pending
  assert.deepEqual(pending.map(item => [item.kind, item.requestId, item.text]), [
    ['goal_progress', newest.requestId, '看懂天气图：我会读等压线和锋面'],
    ['goal_proposal', proposed.requestId, '学会弹吉他'],
  ], 'an older progress proposal for the same goal is left out')
  await goalCommand({ operation: 'update', id: goalId, expectedRevision: 1, title: '看懂天气图', progress: '我会读等压线和锋面' })
  await goalCommand({ operation: 'create', title: '学会弹吉他' })
  assert.deepEqual((await today()).pending, [], 'kept progress and a goal with the same title close the proposals')

  const candidateSource = (await send(stray, '我每天晚上九点后才有空。')).requestId
  await pool.query(`UPDATE users SET memory_suggestions_enabled = true WHERE id = $1`, [user.id])
  await pool.query(`INSERT INTO personal_memory_candidates (user_id, id, source_request_id, fingerprint, kind, body, quote, reason, topic, suggested_for_tutoring)
    VALUES ($1, $2, $3, $4, 'statement', '我晚上九点后才有空。', '九点后才有空', '安排复习时间', '', true)`, [user.id, randomUUID(), candidateSource, 'a'.repeat(64)])
  pending = (await today()).pending
  assert.deepEqual(pending.map(item => [item.kind, item.conversationId, item.text]), [['memory_candidate', stray, '我晚上九点后才有空。']])

  const discussion = randomUUID()
  await send(discussion, '冷锋过境会怎样？', { materialSelection: { excerpt: notes } })
  time += 49 * 3_600_000
  const view = await today()
  assert.deepEqual(view.review && { topic: view.review.topic, conversationId: view.review.conversationId }, { topic: '冷锋过境', conversationId: discussion })
  assert.deepEqual(view.recentConversations.map(item => item.conversationId), [discussion, stray, started])
})
