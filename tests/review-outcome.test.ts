import assert from 'node:assert/strict'
import { test } from 'node:test'
import { intervalForOutcome, reviewOutcome } from '../src/review/proposal.js'

test('a review outcome needs a known result and a short note', () => {
  assert.deepEqual(reviewOutcome({ result: 'partial', note: '只说出了一半' }), { result: 'partial', note: '只说出了一半' })
  assert.equal(reviewOutcome({ result: 'perfect', note: '全对' }), undefined)
  assert.equal(reviewOutcome({ result: 'recalled', note: '' }), undefined)
  assert.equal(reviewOutcome(undefined), undefined)
})

test('the next interval moves the same way as the result', () => {
  assert.equal(intervalForOutcome(30, 'forgotten'), 2)
  assert.equal(intervalForOutcome(1, 'recalled'), 4)
  assert.equal(intervalForOutcome(5, 'partial'), 5)
  assert.equal(intervalForOutcome(14, 'recalled'), 14)
})

test('long review evidence keeps whole sentences around the quote', async () => {
  const { evidencePassage, evidencePassageLimit } = await import('../src/review/proposal.js')
  const filler = '这是一句填充的话。'.repeat(800)
  const quote = '离心结束后等待转子完全停止再开盖。'
  const text = filler + quote + filler
  const passage = evidencePassage(text, quote)
  assert.ok(passage.includes(quote))
  assert.ok(passage.length <= evidencePassageLimit)
  assert.ok(passage.startsWith('这是') && passage.endsWith('。'), 'the passage starts and ends at sentence breaks')
  assert.equal(evidencePassage('短的原文。', '短的'), '短的原文。')
})
