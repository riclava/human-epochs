import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewReplyText } from '../clients/web/src/reply-preview.js'
import { splitConversationReply } from '../src/runtime/conversation-blocks.js'

const handshake = {
  title: 'TCP 三次握手', view: 'sequence',
  participants: [{ id: 'c', label: '客户端' }, { id: 's', label: '服务器' }],
  events: [{ id: 'e1', from: 'c', to: 's', text: 'SYN' }, { id: 'e2', from: 's', to: 'c', text: 'SYN-ACK' }, { id: 'e3', from: 'c', to: 's', text: 'ACK' }],
}
const fenced = (kind: string, value: unknown) => '```' + kind + '\n' + JSON.stringify(value) + '\n```'

test('valid fences become structured blocks in reading order between text blocks', () => {
  const blocks = splitConversationReply(`握手分三步：\n\n${fenced('event_log', handshake)}\n\n第三步之后连接建立。`)
  assert.deepEqual(blocks.map(block => block.kind), ['text', 'event_log', 'text'])
  assert.deepEqual(blocks[0], { kind: 'text', text: '握手分三步：' })
  assert.equal(blocks[1]!.kind === 'event_log' && blocks[1]!.events.length, 3)
  assert.equal(splitConversationReply(fenced('event_log', handshake)).length, 1, 'a reply may be a single view')
})

test('invalid fences stay in the text as code, and invented citations are dropped', () => {
  const broken = { ...handshake, events: [{ id: 'e1', from: 'c', to: 'nobody', text: 'SYN' }] }
  for (const body of [fenced('event_log', broken), '```diagram\n{not json}\n```', fenced('diagram', [1, 2])]) {
    const blocks = splitConversationReply(`说明\n\n${body}\n\n结束`)
    assert.deepEqual(blocks.map(block => block.kind), ['text'])
    assert.ok(blocks[0]!.kind === 'text' && blocks[0]!.text.includes(body))
  }
  const cited = splitConversationReply(fenced('event_log', { ...handshake, citations: [{ sourceId: 'x', label: 'x', quote: 'x' }] }))
  assert.equal(cited[0]!.kind === 'event_log' && cited[0]!.citations, undefined)
  const ordinary = '```python\nprint(1)\n```'
  assert.deepEqual(splitConversationReply(ordinary), [{ kind: 'text', text: ordinary }])
})

test('at most three views are kept per reply', () => {
  const reply = Array.from({ length: 4 }, () => fenced('event_log', handshake)).join('\n\n')
  const blocks = splitConversationReply(reply)
  assert.equal(blocks.filter(block => block.kind === 'event_log').length, 3)
  assert.equal(blocks.at(-1)!.kind, 'text')
})

test('streaming previews hide finished and unfinished view fences', () => {
  assert.equal(previewReplyText(`先看图：\n${fenced('diagram', { title: 'x' })}\n然后`), '先看图：\n\n\n*正在整理图示…*\n\n\n然后')
  assert.equal(previewReplyText('先看图：\n```event_log\n{"title":"TCP'), '先看图：\n\n\n*正在整理图示…*\n\n')
  assert.equal(previewReplyText('先看图：\n```eve'), '先看图：')
  assert.equal(previewReplyText('普通文字'), '普通文字')
})
