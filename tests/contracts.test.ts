import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestHintCommandSchema } from '../src/contracts/activity.js'
import { defaultAgentSettings, saveAgentSettingsRequestSchema } from '../src/contracts/agent-settings.js'
import { conversationContentSchema, conversationContentText, reviewInvitationCommandSchema, sendConversationCommandSchema } from '../src/contracts/conversation.js'
import { personalMemoryCommandSchema } from '../src/contracts/personal-memory.js'

const id = '00000000-0000-4000-8000-000000000001'

test('hint commands require a valid revision and operation ID, and reject forged identity', () => {
  const command = { activityId: id, expectedRevision: 1, commandId: id }
  assert.equal(RequestHintCommandSchema.safeParse(command).success, true)
  assert.equal(RequestHintCommandSchema.safeParse({ activityId: id, revision: 1, commandId: id }).success, false)
  assert.equal(RequestHintCommandSchema.safeParse({ ...command, userId: id }).success, false)
  assert.equal(RequestHintCommandSchema.safeParse({ activityId: id, expectedRevision: 1 }).success, false)
  assert.equal(RequestHintCommandSchema.safeParse({ ...command, expectedRevision: 0 }).success, false)
})

test('conversation, review, settings and memory commands reject obsolete field names', () => {
  const message = { conversationId: id, requestId: id, messageText: '请解释这段原文。' }
  const selection = { excerpt: { label: '笔记', text: '今天下雨了。' } }
  const review = { conversationId: id, commandId: id, action: 'accept' }
  const settings = { settings: defaultAgentSettings }
  const memory = { operation: 'forget', id, commandId: id }

  assert.equal(sendConversationCommandSchema.safeParse({ ...message, materialSelection: selection }).success, true)
  assert.equal(sendConversationCommandSchema.safeParse({ ...message, material: selection }).success, false)
  assert.equal(sendConversationCommandSchema.safeParse({ ...message, reviewId: id }).success, false)
  assert.equal(reviewInvitationCommandSchema.safeParse({ ...review, reviewInvitationId: id }).success, true)
  assert.equal(reviewInvitationCommandSchema.safeParse({ ...review, invitationId: id }).success, false)
  assert.equal(saveAgentSettingsRequestSchema.safeParse({ ...settings, expectedRevision: 0 }).success, true)
  assert.equal(saveAgentSettingsRequestSchema.safeParse({ ...settings, revision: 0 }).success, false)
  assert.equal(personalMemoryCommandSchema.safeParse({ ...memory, expectedRevision: 1 }).success, true)
  assert.equal(personalMemoryCommandSchema.safeParse({ ...memory, revision: 1 }).success, false)
})

test('event log blocks reject broken references, unknown views and duplicate IDs', () => {
  const block = {
    id, kind: 'event_log', title: '借书', view: 'sequence',
    participants: [{ id: 'lin', label: '小林' }, { id: 'staff', label: '馆员' }],
    events: [{ id: 'e1', from: 'lin', to: 'staff', text: '借书' }, { id: 'e2', from: 'staff', text: '查找' }],
    citations: [{ sourceId: 'notes', label: '记录', quote: '小林借书。' }],
  }
  const parse = (value: object) => conversationContentSchema.safeParse([value]).success
  assert.equal(parse(block), true)
  assert.equal(parse({ ...block, view: 'list' }), true)
  assert.equal(parse({ ...block, view: 'chart' }), false)
  assert.equal(parse({ ...block, citations: [] }), false)
  const { citations: _citations, ...uncited } = block
  assert.equal(parse(uncited), true, 'ordinary conversation views carry no citations')
  assert.equal(parse({ ...block, events: [{ id: 'e1', from: 'lin', to: 'reader', text: '借书' }] }), false)
  assert.equal(parse({ ...block, events: [{ id: 'e1', from: 'nobody', text: '借书' }] }), false)
  assert.equal(parse({ ...block, events: [block.events[0], { ...block.events[1], id: 'e1' }] }), false)
  assert.equal(parse({ ...block, participants: [block.participants[0], { id: 'lin', label: '另一个' }] }), false)
  assert.equal(parse({ ...block, participants: [] }), false)
  assert.equal(parse({ ...block, events: [{ id: 'e 1', from: 'lin', text: '借书' }] }), false)
  assert.equal(conversationContentSchema.safeParse([block, { ...block }]).success, false, 'block IDs stay unique')
  assert.equal(conversationContentText(conversationContentSchema.parse([block])), '借书\n1. 小林 → 馆员：借书\n2. 馆员：查找')
})

test('diagram blocks reject unknown nodes, self edges and duplicate edges', () => {
  const block = {
    id, kind: 'diagram', title: '借书流程',
    nodes: [{ id: 'ask', label: '询问' }, { id: 'reserve', label: '登记预约' }, { id: 'notify', label: '到书通知' }, { id: 'note', label: '备注' }],
    edges: [{ from: 'ask', to: 'reserve', label: '书已借出' }, { from: 'reserve', to: 'notify' }],
    citations: [{ sourceId: 'notes', label: '记录', quote: '小林登记预约。' }],
  }
  const parse = (value: object) => conversationContentSchema.safeParse([value]).success
  assert.equal(parse(block), true)
  assert.equal(parse({ ...block, edges: [{ from: 'ask', to: 'missing' }] }), false)
  assert.equal(parse({ ...block, edges: [{ from: 'ask', to: 'ask' }] }), false)
  assert.equal(parse({ ...block, edges: [block.edges[0], { from: 'ask', to: 'reserve', label: '另一条' }] }), false)
  assert.equal(parse({ ...block, nodes: [block.nodes[0], { id: 'ask', label: '重复' }] }), false)
  assert.equal(parse({ ...block, edges: [] }), false)
  assert.equal(parse({ ...block, nodes: [block.nodes[0]] }), false)
  assert.equal(parse({ ...block, nodes: [...block.nodes.slice(1), { id: 'ask', label: '超'.repeat(25) }] }), false)
  assert.equal(conversationContentText(conversationContentSchema.parse([block])),
    '借书流程\n- 询问 → 登记预约（书已借出）\n- 登记预约 → 到书通知\n- 备注')
})
