import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestHintCommandSchema } from '../src/contracts/activity.js'
import { defaultAgentSettings, saveAgentSettingsRequestSchema } from '../src/contracts/agent-settings.js'
import { reviewInvitationCommandSchema, sendConversationCommandSchema } from '../src/contracts/conversation.js'
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
  const message = { requestId: id, messageText: '请解释这段原文。' }
  const selection = { excerpt: { label: '笔记', text: '今天下雨了。' } }
  const review = { commandId: id, action: 'accept' }
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
