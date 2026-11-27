import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeDiscussion, describeLabels, materialBudget, materialSelectionFor } from '../clients/web/src/material-draft.js'
import type { ConversationTurn } from '../src/contracts/conversation.js'

const turn = (requestId: string, status: ConversationTurn['status'], sources?: { id: string; label: string; text: string }[]): ConversationTurn => ({
  // Turns show each source's length and opening, as the conversation snapshot does.
  kind: 'user', requestId, status, messageText: requestId, replyBlocks: null,
  ...(sources ? { materialContext: { discussionVersion: null, discussionId: requestId,
    sources: sources.map(({ id, label, text }) => ({ id, label, length: text.length, preview: text, truncated: false, deleted: false })) } } : {}),
})
const notes = [{ id: 'a', label: '气象笔记', text: '九点二十度。' }, { id: 'b', label: '补充', text: '十点二十二度。' }]

test('the latest finished turn decides which discussion a new message continues', () => {
  assert.equal(activeDiscussion([]), null)
  assert.deepEqual(activeDiscussion([turn('m1', 'complete', notes)]),
    { requestId: 'm1', labels: ['气象笔记', '补充'], sourceCount: 2, textLength: 13, sourceIds: ['a', 'b'] })
  assert.equal(activeDiscussion([turn('m1', 'complete', notes), turn('t2', 'complete')]), null, 'a plain message ends the discussion')
  assert.equal(activeDiscussion([turn('m1', 'complete', notes), turn('t2', 'retryable')])?.requestId, 'm1', 'unfinished turns are skipped')
  const question: ConversationTurn = { kind: 'review_question', requestId: 'q', status: 'complete', questionBlocks: [{ kind: 'text', id: '00000000-0000-4000-8000-000000000001', text: '?' }] }
  assert.equal(activeDiscussion([turn('m1', 'complete', notes), question]), null)
})

test('the next message carries the continued discussion, a new source, both or neither', () => {
  const discussion = activeDiscussion([turn('m1', 'complete', notes)])
  const attachment = { label: '新原文', text: '下午三点二十五度。' }
  assert.deepEqual(materialSelectionFor(discussion, undefined, false), { parentRequestId: 'm1' })
  assert.deepEqual(materialSelectionFor(discussion, attachment, false), { parentRequestId: 'm1', excerpt: attachment })
  assert.deepEqual(materialSelectionFor(discussion, attachment, true), { excerpt: attachment })
  assert.deepEqual(materialSelectionFor(discussion, { materialId: '00000000-0000-4000-8000-000000000009', label: '讲义', length: 9 }, false),
    { parentRequestId: 'm1', materialIds: ['00000000-0000-4000-8000-000000000009'] }, 'a library material is chosen by reference')
  assert.equal(materialSelectionFor(discussion, undefined, true), undefined)
  assert.equal(materialSelectionFor(null, undefined, false), undefined)
  assert.deepEqual(materialBudget(discussion), { text: 500_000 - 13, sources: 14 })
  assert.equal(describeLabels(['甲', '乙', '丙']), '甲、乙 等 3 份')
})

test('an unnamed source is named after its first sentence', async () => {
  const { defaultLabel } = await import('../clients/web/src/MaterialComposer.js')
  assert.equal(defaultLabel('周一上午，小林到图书馆借书。馆员说书已借出。'), '周一上午，小林到图书馆借书')
  assert.equal(defaultLabel('甲'.repeat(30)), '甲'.repeat(19) + '…')
  assert.equal(defaultLabel('   \n  '), '我的原文')
})
