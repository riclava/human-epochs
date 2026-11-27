import assert from 'node:assert/strict'
import { test } from 'node:test'
import { memoryApplies, memoryRelevance, relevanceTokens, selectMemories } from '../src/app/memory-relevance.js'

const memory = (id: string, topic: string, body: string) => ({ id, topic, body })
const exam = memory('exam', '雅思', '我准备明年三月考雅思，目标总分 7 分。')
const speaking = memory('speaking', '雅思', '我的雅思口语是最弱的一项。')
const photos = memory('photos', 'Python', '我想用 Python 做一个自动整理照片的小脚本')
const schedule = memory('schedule', '', '我一般晚上十点以后才有空学习，每次大概半小时。')
const examples = memory('examples', '', '我学习时更喜欢先看例子再看定义。')

test('tokens are whole Latin words and Han character pairs without common filler words', () => {
  assert.deepEqual([...relevanceTokens('我想用 Python 读 CSV')], ['python', 'csv', '想用'])
  assert.deepEqual([...relevanceTokens('雅思口语')], ['雅思', '思口', '口语'])
  assert.deepEqual([...relevanceTokens('C++ 和 node.js')], ['node.js'])
})

test('a related memory is used without its topic appearing in the question', () => {
  assert.ok(memoryRelevance('口语怎么练比较快？', speaking) > 0)
  assert.ok(memoryRelevance('怎么批量重命名照片文件？', photos) > 0)
  assert.equal(memoryRelevance('怎么批量重命名照片文件？', exam), 0)
  assert.ok(memoryRelevance('雅思口语怎么准备？', speaking) > memoryRelevance('口语怎么练？', speaking), 'the whole topic counts most')
  assert.equal(memoryRelevance('我想知道什么时候比较合适', speaking), 0, 'filler words alone do not relate')
})

test('related memories come first and general memories fill the remaining places', () => {
  const all = [schedule, exam, photos, examples, speaking]
  assert.deepEqual(selectMemories('口语怎么练？', all).map(item => item.id), ['speaking', 'schedule', 'examples'])
  assert.deepEqual(selectMemories('什么是闭包？', all).map(item => item.id), ['schedule', 'examples'])
  assert.deepEqual(selectMemories('雅思口语和照片脚本', all, 2).map(item => item.id), ['speaking', 'exam'])
  assert.equal(memoryApplies('研究月球', photos), false)
  assert.equal(memoryApplies('研究月球', schedule), true)
})
