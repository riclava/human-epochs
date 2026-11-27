import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSourceReader, sourceCatalog, sourcePartSize, sourceParts } from '../src/runtime/tools/read-source.js'

const paragraph = (n: number) => `第 ${n} 段：` + '这是用来凑长度的说明文字。'.repeat(20) + '\n'
const long = { id: 'excerpt:book', label: '讲义', text: Array.from({ length: 60 }, (_, n) => paragraph(n + 1)).join('') + '关键结论：光反应发生在类囊体膜上。\n' }

test('sources split into parts at paragraph breaks, and an over-long paragraph is cut', () => {
  const parts = sourceParts(long.text)
  assert.ok(parts.length > 3)
  assert.ok(parts.every(part => part.length <= sourcePartSize))
  assert.ok(parts.slice(0, -1).every(part => part.endsWith('。')), 'parts end where a paragraph ends')
  assert.deepEqual(sourceParts('字'.repeat(7000)).map(part => part.length), [3000, 3000, 1000])
  assert.deepEqual(sourceCatalog([long]), [{ id: long.id, label: '讲义', length: long.text.length, parts: parts.length }])
})

test('search points to the relevant part, and only parts actually read count as read', () => {
  const { tools, readSources } = createSourceReader([long])
  const [read, search] = tools
  const found = search!.execute({ query: '光反应在哪里发生' }, 's1')
  const [best] = (found.output as { results: { sourceId: string; part: number; text: string }[] }).results
  const parts = sourceParts(long.text)
  assert.equal(best?.part, parts.length, 'the part holding the conclusion ranks first')
  assert.ok(best!.text.includes('关键结论：光反应发生在类囊体膜上。') && best!.text.length <= 600, 'search returns the passage around the match')
  assert.ok(long.text.includes(best!.text), 'the passage is an exact slice of the source')
  assert.deepEqual(readSources(), [{ id: long.id, label: '讲义', text: best!.text }], 'a passage search returned counts as seen')

  const first = read!.execute({ sourceId: long.id, part: best!.part }, 'r1')
  assert.deepEqual(first.output, { id: long.id, label: '讲义', part: best!.part, parts: parts.length, text: parts.at(-1) })
  assert.deepEqual(read!.execute({ sourceId: long.id, part: best!.part }, 'r2').output,
    { id: long.id, part: best!.part, previousToolCallId: 'r1' }, 'reading the same part again refers to the first read')
  assert.equal(read!.execute({ sourceId: long.id, part: parts.length + 1 }, 'r3').outcome, 'invalid_input')
  assert.equal(read!.execute({ sourceId: 'excerpt:other' }, 'r4').outcome, 'denied')
  assert.deepEqual(readSources(), [{ id: long.id, label: '讲义', text: parts.at(-1) }], 'a passage inside a read part is not repeated')
})
