import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RequestHintCommandSchema } from '../src/contracts/learning.js'

const id = '00000000-0000-4000-8000-000000000001'

test('hint commands require a valid revision and operation ID, and reject forged identity', () => {
  const command = { activityId: id, revision: 1, commandId: id }
  assert.equal(RequestHintCommandSchema.safeParse(command).success, true)
  assert.equal(RequestHintCommandSchema.safeParse({ ...command, learnerId: id }).success, false)
  assert.equal(RequestHintCommandSchema.safeParse({ activityId: id, revision: 1 }).success, false)
  assert.equal(RequestHintCommandSchema.safeParse({ ...command, revision: 0 }).success, false)
})
