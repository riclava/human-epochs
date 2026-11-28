import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { LearningGoalList } from '../src/contracts/learning-goal.js'
import type { ModelClient } from '../src/runtime/model.js'
import { splitConversationReply, settleGoalProposals } from '../src/runtime/conversation-blocks.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const proposal = '```goal\n{"title":"看懂天气图","motivation":"想自己判断周末能不能登山"}\n```'

test('a reply keeps one valid goal proposal, and proposals do not count against diagrams', () => {
  const diagram = (title: string) => '```diagram\n' + JSON.stringify({ title, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }) + '\n```'
  const blocks = splitConversationReply([
    '先从等压线开始。', diagram('一'), diagram('二'), diagram('三'), proposal, '```goal\n{"title":"第二个"}\n```',
  ].join('\n\n'))
  assert.deepEqual(blocks.map(block => block.kind), ['text', 'diagram', 'diagram', 'diagram', 'goal_proposal'])
  assert.deepEqual(blocks.at(-1), { kind: 'goal_proposal', title: '看懂天气图', motivation: '想自己判断周末能不能登山' })
  const invalid = splitConversationReply('好的。\n\n```goal\n{"title":""}\n```')
  assert.deepEqual(invalid, [{ kind: 'text', text: '好的。' }], 'an invalid proposal is dropped, not shown as raw JSON')
  const long = splitConversationReply('对。\n\n```goal_progress\n{"progress":"' + '会'.repeat(81) + '"}\n```')
  assert.deepEqual(long, [{ kind: 'text', text: '对。' }], 'progress over 80 characters is dropped too')
  assert.deepEqual(splitConversationReply('```goal\n{"title":"只有标题"}\n```'), [{ kind: 'goal_proposal', title: '只有标题', motivation: '' }],
    'the reason may be left out')
})

test('a proposal that repeats an existing goal is dropped, ignoring spacing and punctuation', () => {
  const blocks = splitConversationReply('好的。\n\n' + proposal)
  assert.deepEqual(settleGoalProposals(blocks, ['看懂 天气图！']).map(block => block.kind), ['text'])
  assert.deepEqual(settleGoalProposals(blocks, ['系统地看懂天气图']).map(block => block.kind), ['text'], 'a longer existing title covers it')
  assert.deepEqual(settleGoalProposals(blocks, ['系统学会看天气图判断登山']).map(block => block.kind), ['text'], 'a reworded title is the same goal')
  assert.deepEqual(settleGoalProposals(blocks, ['学吉他', '', '看懂财务报表']).map(block => block.kind), ['text', 'goal_proposal'], 'different goals stay')
  const python = splitConversationReply('```goal\n{"title":"学 Python 写爬虫"}\n```')
  assert.equal(settleGoalProposals(python, ['用 Python 做数据分析']).length, 1, 'one shared word does not make the same goal')
  assert.equal(settleGoalProposals(python, ['python爬虫']).length, 0)
})

test('goals are changed by receipted commands, within their limits, and only by their owner', async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, null)
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const run = (payload: object, asCookie = cookie) => server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie: asCookie }, payload })
  const goal = { title: '看懂天气图', motivation: '周末登山', progress: '', status: 'active' }

  const commandId = randomUUID()
  const created = await run({ operation: 'create', commandId, ...goal })
  assert.equal(created.statusCode, 200, created.payload)
  const [saved] = created.json<LearningGoalList>().goals
  assert.deepEqual({ id: saved!.id, revision: saved!.revision, title: saved!.title, proposal: saved!.proposalBlockId }, { id: commandId, revision: 1, title: goal.title, proposal: null })
  assert.equal((await run({ operation: 'create', commandId, ...goal })).json<LearningGoalList>().goals.length, 1, 'a replay creates nothing')
  assert.equal((await run({ operation: 'create', commandId, ...goal, title: '别的' })).statusCode, 409, 'a reused ID with other content conflicts')

  const update = { operation: 'update', id: commandId, expectedRevision: 1, ...goal, progress: '认识了等压线', status: 'paused' }
  assert.equal((await run({ ...update, commandId: randomUUID() })).json<LearningGoalList>().goals[0]!.progress, '认识了等压线')
  assert.equal((await run({ ...update, commandId: randomUUID() })).statusCode, 409, 'a stale revision conflicts')
  assert.equal((await run({ ...update, commandId: randomUUID(), title: '  ' })).statusCode, 400)

  for (let index = 0; index < 5; index++) assert.equal((await run({ operation: 'create', commandId: randomUUID(), ...goal, title: '目标' + index })).statusCode, 200)
  const sixth = await run({ operation: 'create', commandId: randomUUID(), ...goal, title: '第六个' })
  assert.deepEqual([sixth.statusCode, sixth.json().reason], [409, 'limit'], 'at most five goals are active')
  const resume = await run({ operation: 'update', commandId: randomUUID(), id: commandId, expectedRevision: 2, ...goal, status: 'active' })
  assert.equal(resume.json().reason, 'limit', 'resuming counts against the active limit too')
  assert.equal((await run({ operation: 'create', commandId: randomUUID(), ...goal, title: '先暂停', status: 'paused' })).statusCode, 200)

  const other = await login(server, 'bob@example.test')
  assert.deepEqual((await server.inject({ url: '/api/learning-goals', headers: { cookie: other } })).json(), { goals: [] })
  assert.equal((await run({ operation: 'delete', commandId: randomUUID(), id: commandId, expectedRevision: 2 }, other)).statusCode, 404)
  const removed = await run({ operation: 'delete', commandId: randomUUID(), id: commandId, expectedRevision: 2 })
  assert.equal(removed.json<LearningGoalList>().goals.some(item => item.id === commandId), false)
  const listed = (await server.inject({ url: '/api/learning-goals', headers: { cookie } })).json<LearningGoalList>().goals
  assert.deepEqual(listed.map(item => item.status), ['active', 'active', 'active', 'active', 'active', 'paused'], 'active goals come first')
})

test('the Agent proposes a goal, the user accepts it once, and active goals reach later replies without guarding them', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const inputs: string[] = []
  let streamed = 0
  const model: ModelClient = async ({ messages, onTextDelta }) => {
    inputs.push(JSON.stringify(messages))
    const text = inputs.length === 2 ? '先看高压和低压的位置。' : '可以从等压线学起。\n\n' + proposal
    onTextDelta?.(text)
    if (onTextDelta) streamed++
    return { kind: 'text', text }
  }
  const server = createApp(pool, model)
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const conversationId = randomUUID()
  const send = async (messageText: string) => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
      payload: { conversationId, requestId: randomUUID(), messageText } })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const run = (payload: object, asCookie = cookie) => server.inject({ method: 'POST', url: '/api/learning-goals/commands', headers: { cookie: asCookie }, payload })

  const first = await send('我想学会看天气图，周末想自己判断能不能登山。')
  const block = first.replyBlocks!.find(item => item.kind === 'goal_proposal')
  assert.ok(block && block.kind === 'goal_proposal')
  assert.equal(block.title, '看懂天气图')
  assert.ok(!first.replyBlocks!.some(item => item.kind === 'text' && item.text.includes('```')), 'the proposal is not left in the text')

  const accept = (requestId: string, blockId: string, asCookie = cookie) => run({ operation: 'create', commandId: randomUUID(), title: block.title,
    motivation: block.motivation, progress: '', status: 'active', proposal: { requestId, blockId } }, asCookie)
  assert.equal((await accept(first.requestId, randomUUID())).statusCode, 400, 'the proposal must be in the reply')
  assert.equal((await accept(first.requestId, block.id, await login(server, 'bob@example.test'))).statusCode, 400, 'another user cannot accept it')
  const accepted = await accept(first.requestId, block.id)
  assert.equal(accepted.statusCode, 200, accepted.payload)
  assert.equal(accepted.json<LearningGoalList>().goals[0]!.proposalBlockId, block.id)
  assert.equal((await accept(first.requestId, block.id)).statusCode, 409, 'one proposal makes one goal')
  await run({ operation: 'create', commandId: randomUUID(), title: '学吉他', motivation: '', progress: '', status: 'paused' })

  const second = await send('高压和低压怎么看？')
  assert.equal(second.status, 'complete')
  assert.ok(inputs[1]!.includes('看懂天气图') && inputs[1]!.includes('想自己判断周末能不能登山'), 'the active goal is in the model input')
  assert.ok(!inputs[1]!.includes('学吉他'), 'paused goals are not sent')
  assert.ok(!inputs[0]!.includes('"goals":[{'), 'nothing is sent before a goal exists')
  assert.equal(streamed, 2, 'a reply that only read goals still streams')
  const third = await send('我想学会看天气图，从哪开始？')
  assert.deepEqual(third.replyBlocks!.map(item => item.kind), ['text'], 'the Agent does not propose a goal the user already has')
  assert.deepEqual(second.memoryIds ?? [], [])
})
