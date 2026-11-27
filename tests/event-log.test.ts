import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import type { ConversationSnapshot, UserConversationTurn } from '../src/contracts/conversation.js'
import type { MaterialPrompt } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

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
      payload: { requestId, messageText, materialSelection } })
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
  const phoneView: ConversationSnapshot = (await server.inject({ url: '/api/conversation', headers: { cookie: phone } })).json()
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
