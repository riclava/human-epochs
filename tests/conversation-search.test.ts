import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { searchTerms, snippetOf } from '../src/app/conversation-search.js'
import { createApp } from '../src/app/create-app.js'
import type { SearchResponse } from '../src/contracts/search.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()

test('snippets cut around the first word and mark every word, merging overlaps', () => {
  assert.deepEqual(searchTerms('  等压线  Front front 等压线 '), ['等压线', 'front'])
  const text = '开头'.repeat(30) + '冷锋过境时，等压线变密，风力加大。' + '结尾'.repeat(80)
  const cut = snippetOf(text, ['等压线', '压线变'])
  assert.equal(cut.clippedStart && cut.clippedEnd, true)
  const marked = cut.highlights.map(([start, end]) => cut.snippet.slice(start, end))
  assert.deepEqual(marked, ['等压线变'], 'overlapping words become one mark')
  assert.deepEqual(snippetOf('Cold FRONT and front', ['front']).highlights, [[5, 10], [15, 20]], 'matching ignores case')
  assert.deepEqual(snippetOf('短句', ['短']), { snippet: '短句', clippedStart: false, clippedEnd: false, highlights: [[0, 1]] })
})

test('search finds the user\'s own titles, messages and replies, with every word, literally', { timeout: 15_000 }, async t => {
  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  const server = createApp(pool, async ({ messages }) => {
    const question = String(messages.at(-1)!.content)
    return { kind: 'text', text: question.includes('冷锋') ? '冷锋过境后气温下降，气压上升。' : '先认识高压和低压。' }
  })
  t.after(() => server.close())
  const cookie = await login(server, user.email)
  const send = async (conversationId: string, messageText: string, asCookie = cookie) => {
    const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: asCookie },
      payload: { conversationId, requestId: randomUUID(), messageText } })
    return readConversationTurn(response.payload, String(response.headers['content-type']))
  }
  const search = async (q: string, asCookie = cookie) =>
    (await server.inject({ url: '/api/conversation-search?q=' + encodeURIComponent(q), headers: { cookie: asCookie } })).json<SearchResponse>()

  const weather = randomUUID()
  const fronts = await send(weather, '冷锋来了天气怎么变？')
  await send(weather, '天气图怎么看？')
  const other = randomUUID()
  await send(other, '100% 确定吗？')
  await server.inject({ method: 'POST', url: `/api/conversations/${other}/commands`, headers: { cookie },
    payload: { operation: 'rename', commandId: randomUUID(), title: '杂项笔记' } })
  await send(randomUUID(), '冷锋是什么？', await login(server, 'bob@example.test'))

  const reply = await search('气压上升')
  assert.deepEqual(reply.results.map(result => [result.conversationId, result.matches.map(match => [match.requestId, match.field])]),
    [[weather, [[fronts.requestId, 'reply']]]])
  assert.deepEqual(reply.results[0]!.matches[0]!.highlights.map(([start, end]) => reply.results[0]!.matches[0]!.snippet.slice(start, end)), ['气压上升'])

  const both = await search('冷锋 下降')
  assert.equal(both.results[0]?.matches[0]?.field, 'reply', 'the side holding more of the words gives the snippet')
  assert.deepEqual((await search('冷锋 月亮')).results, [], 'every word must appear')
  assert.deepEqual((await search('天气')).results[0]!.matches.map(match => match.field), ['title', 'message', 'message'],
    'the title (taken from the first message) comes first, then turns newest first')
  assert.deepEqual((await search('杂项')).results.map(result => [result.title, result.matches[0]!.field]), [['杂项笔记', 'title']])
  assert.equal((await search('%')).results.length, 1, 'a percent sign is matched literally')
  assert.deepEqual((await search('冷锋', await login(server, 'bob@example.test'))).results.length, 1, 'each user sees only their own')
  assert.equal((await server.inject({ url: '/api/conversation-search?q=%20', headers: { cookie } })).statusCode, 400)
  assert.equal((await server.inject({ url: '/api/conversation-search?q=' + 'x'.repeat(101), headers: { cookie } })).statusCode, 400)
})
