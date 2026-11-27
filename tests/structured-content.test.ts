import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot, UserConversationTurn } from '../src/contracts/conversation.js'
import type { MaterialPrompt } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

// Every user in this file talks in a conversation with this ID; each user gets their own conversation row.
const conversationId = randomUUID()

const pool = useTestDatabase()

const excerpt = { label: '借书记录（合成）', text: '小林向馆员借《史记》。馆员查到书已借出，请小林登记预约。小林登记后，馆员说书到了会通知。' }
const participants = [{ id: 'lin', label: '小林' }, { id: 'staff', label: '馆员' }]
const events = [
  { id: 'e1', from: 'lin', to: 'staff', text: '借《史记》' },
  { id: 'e2', from: 'staff', to: 'lin', text: '书已借出，请登记预约' },
  { id: 'e3', from: 'lin', text: '登记预约' },
  { id: 'e4', from: 'staff', to: 'lin', text: '书到了会通知' },
]

test('event logs are verified, published once and read back identically on both devices', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const histories: string[] = []
  let reply: (sourceId: string) => object = () => ({})
  const server = createApp(pool, async ({ format, messages }) => {
    assert.equal(format, 'json')
    const prompt: MaterialPrompt = JSON.parse(messages[0]!.content!)
    histories.push(JSON.stringify(prompt.history))
    return { kind: 'text', text: JSON.stringify(reply(prompt.sources[0]!.id)) }
  })
  t.after(() => server.close())
  const desktop = await login(server, user.email)
  const phone = await login(server, user.email)
  const ask = async (cookie: string, requestId: string, messageText: string, materialSelection: object) => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
      payload: { conversationId, requestId, messageText, materialSelection } })
    assert.equal(response.statusCode, 200, response.payload)
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const eventLog = (sourceId: string, overrides: object = {}) => ({
    kind: 'event_log', title: '借书时的往来', view: 'sequence', participants, events,
    citations: [{ sourceId, quote: '馆员查到书已借出，请小林登记预约。' }], ...overrides,
  })

  reply = sourceId => ({ blocks: [eventLog(sourceId), {
    kind: 'text', text: '关键在第二步：书不在馆，所以需要预约。', citations: [{ sourceId, quote: '馆员查到书已借出' }],
  }] })
  const rootId = randomUUID()
  const first = await ask(desktop, rootId, '借书时发生了什么？', { excerpt })
  assert.equal(first.explanationSource, 'model')
  const [log, explanation] = first.replyBlocks!
  assert.equal(log?.kind, 'event_log')
  assert.equal(explanation?.kind, 'text')
  if (log?.kind !== 'event_log') return
  assert.deepEqual(log.events, events)
  assert.deepEqual(log.citations, [{ sourceId: 'excerpt:' + rootId, label: excerpt.label, quote: '馆员查到书已借出，请小林登记预约。' }])

  const retried = await ask(phone, rootId, '借书时发生了什么？', { excerpt })
  assert.deepEqual(retried.replyBlocks, first.replyBlocks, 'a completed request replays the same block IDs and order')
  const phoneView: ConversationSnapshot = (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie: phone } })).json()
  assert.deepEqual((phoneView.turns.at(-1) as UserConversationTurn).replyBlocks, first.replyBlocks)

  reply = sourceId => ({ blocks: [{ kind: 'text', text: '预约发生在书已借出之后。', citations: [{ sourceId, quote: '小林登记后' }] }] })
  await ask(desktop, randomUUID(), '预约是在什么时候？', { parentRequestId: rootId })
  assert.match(histories.at(-1)!, /借书时的往来\\n1\. 小林 → 馆员：借《史记》/u, 'follow-ups read the event log as text')
  assert.match(histories.at(-1)!, /3\. 小林：登记预约/u)

  const invalid: [string, (sourceId: string) => object][] = [
    ['unknown participant', sourceId => eventLog(sourceId, { events: [{ id: 'e1', from: 'lin', to: 'reader', text: '借书' }] })],
    ['duplicate event', sourceId => eventLog(sourceId, { events: [events[0], { ...events[1], id: 'e1' }] })],
    ['unsupported view', sourceId => eventLog(sourceId, { view: 'chart' })],
    ['unsourced citation', sourceId => eventLog(sourceId, { citations: [{ sourceId, quote: '馆员把书送到了家' }] })],
    ['unsourced quotation', sourceId => eventLog(sourceId, { events: [{ id: 'e1', from: 'lin', text: '小林说“我明天再来”' }] })],
  ]
  for (const [name, block] of invalid) {
    reply = sourceId => ({ blocks: [block(sourceId)] })
    const fallback = await ask(desktop, randomUUID(), '借书时发生了什么？', { excerpt })
    assert.equal(fallback.status, 'complete', name)
    assert.equal(fallback.explanationSource, 'excerpt', name)
    assert.ok(fallback.replyBlocks!.every(block => block.kind !== 'event_log'), name)
  }
})

test('diagrams are verified, published and read back as text for follow-ups', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const histories: string[] = []
  let reply: (sourceId: string) => object = () => ({})
  const server = createApp(pool, async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(messages[0]!.content!)
    histories.push(JSON.stringify(prompt.history))
    return { kind: 'text', text: JSON.stringify(reply(prompt.sources[0]!.id)) }
  })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const ask = async (requestId: string, messageText: string, materialSelection: object) => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
      payload: { conversationId, requestId, messageText, materialSelection } })
    assert.equal(response.statusCode, 200, response.payload)
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const nodes = [{ id: 'ask', label: '借书' }, { id: 'reserve', label: '登记预约' }, { id: 'notify', label: '到书通知' }]
  const edges = [{ from: 'ask', to: 'reserve', label: '书已借出' }, { from: 'reserve', to: 'notify' }]
  const diagram = (sourceId: string, overrides: object = {}) => ({
    kind: 'diagram', title: '借书流程', nodes, edges, citations: [{ sourceId, quote: '小林登记后' }], ...overrides,
  })

  reply = sourceId => ({ blocks: [diagram(sourceId), { kind: 'text', text: '预约是借不到书时的下一步。', citations: [{ sourceId, quote: '请小林登记预约' }] }] })
  const rootId = randomUUID()
  const first = await ask(rootId, '借书流程是什么？', { excerpt })
  assert.equal(first.explanationSource, 'model')
  const [block] = first.replyBlocks!
  assert.equal(block?.kind, 'diagram')
  if (block?.kind !== 'diagram') return
  assert.deepEqual({ nodes: block.nodes, edges: block.edges }, { nodes, edges })

  reply = sourceId => ({ blocks: [{ kind: 'text', text: '到书后会通知。', citations: [{ sourceId, quote: '书到了会通知' }] }] })
  await ask(randomUUID(), '最后一步是什么？', { parentRequestId: rootId })
  assert.match(histories.at(-1)!, /借书流程\\n- 借书 → 登记预约（书已借出）\\n- 登记预约 → 到书通知/u)

  const invalid: [string, (sourceId: string) => object][] = [
    ['unknown node', sourceId => diagram(sourceId, { edges: [{ from: 'ask', to: 'return' }] })],
    ['self edge', sourceId => diagram(sourceId, { edges: [{ from: 'ask', to: 'ask' }] })],
    ['duplicate edge', sourceId => diagram(sourceId, { edges: [edges[0], { ...edges[0], label: '再次' }] })],
    ['unsourced citation', sourceId => diagram(sourceId, { citations: [{ sourceId, quote: '馆员送书上门' }] })],
    ['unsourced quotation', sourceId => diagram(sourceId, { nodes: [nodes[0], nodes[1], { id: 'notify', label: '“送书上门”' }] })],
  ]
  for (const [name, block] of invalid) {
    reply = sourceId => ({ blocks: [block(sourceId)] })
    const fallback = await ask(randomUUID(), '借书流程是什么？', { excerpt })
    assert.equal(fallback.explanationSource, 'excerpt', name)
    assert.ok(fallback.replyBlocks!.every(item => item.kind !== 'diagram'), name)
  }
})

test('citations placed on events or edges move to the block and are still verified', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let reply: (sourceId: string) => object = () => ({})
  const server = createApp(pool, async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(messages[0]!.content!)
    return { kind: 'text', text: JSON.stringify(reply(prompt.sources[0]!.id)) }
  })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const ask = async () => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie },
      payload: { conversationId, requestId: randomUUID(), messageText: '借书时发生了什么？', materialSelection: { excerpt } } })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const cited = (sourceId: string, quote: string) => [{ sourceId, quote }]

  reply = sourceId => ({ blocks: [{ kind: 'event_log', title: '借书', view: 'list', participants,
    events: [{ ...events[0], citations: cited(sourceId, '小林向馆员借《史记》') }, { ...events[1], citations: cited(sourceId, '馆员查到书已借出') }] }] })
  const hoisted = await ask()
  assert.equal(hoisted.explanationSource, 'model')
  const [block] = hoisted.replyBlocks!
  assert.equal(block?.kind, 'event_log')
  if (block?.kind !== 'event_log') return
  assert.deepEqual(block.citations?.map(citation => citation.quote), ['小林向馆员借《史记》', '馆员查到书已借出'])
  assert.ok(block.events.every(event => !('citations' in event)))

  reply = sourceId => ({ blocks: [{ kind: 'diagram', title: '借书', nodes: [{ id: 'a', label: '借书' }, { id: 'b', label: '预约' }],
    edges: [{ from: 'a', to: 'b', citations: cited(sourceId, '馆员把书送到了家') }] }] })
  assert.equal((await ask()).explanationSource, 'excerpt', 'a nested citation that is not in the source still fails')
})

test('ordinary conversation publishes uncited views from fenced replies and reads them back as text', { timeout: 10_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const histories: string[] = []
  const handshake = { title: 'TCP 三次握手', view: 'sequence', participants: [{ id: 'c', label: '客户端' }, { id: 's', label: '服务器' }],
    events: [{ id: 'e1', from: 'c', to: 's', text: 'SYN' }, { id: 'e2', from: 's', to: 'c', text: 'SYN-ACK' }] }
  const server = createApp(pool, async ({ format, messages }) => {
    assert.equal(format, 'text')
    histories.push(JSON.stringify(messages))
    return { kind: 'text', text: histories.length === 1
      ? '握手过程如下：\n\n```event_log\n' + JSON.stringify(handshake) + '\n```\n\n最后客户端回 ACK。'
      : '对，第三步是 ACK。' }
  })
  t.after(() => server.close())
  const desktop = await login(server, user.email)
  const phone = await login(server, user.email)
  const send = async (messageText: string) => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: desktop },
      payload: { conversationId, requestId: randomUUID(), messageText } })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }

  const first = await send('TCP 三次握手是怎么回事？')
  assert.equal(first.status, 'complete')
  assert.deepEqual(first.replyBlocks!.map(block => block.kind), ['text', 'event_log', 'text'])
  const view = first.replyBlocks![1]!
  assert.ok(view.kind === 'event_log' && view.citations === undefined && view.events.length === 2)
  const phoneView: ConversationSnapshot = (await server.inject({ url: '/api/conversations/' + conversationId, headers: { cookie: phone } })).json()
  assert.deepEqual((phoneView.turns.at(-1) as UserConversationTurn).replyBlocks, first.replyBlocks)

  await send('第三步是什么？')
  assert.match(histories.at(-1)!, /TCP 三次握手\\n1\. 客户端 → 服务器：SYN/u)
})
