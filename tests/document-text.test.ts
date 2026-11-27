import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageRangeLabel, pagesText, pagesThatFit } from '../clients/web/src/document-text.js'

const pages = ['第一页内容。', '第二页内容。', '第三页内容。']

test('page text marks each page with its number', () => {
  assert.equal(pagesText(pages, 2, 3), '【第 2 页】\n第二页内容。\n\n【第 3 页】\n第三页内容。')
})

test('the longest leading page range that fits is chosen, and its label names the range', () => {
  const one = pagesText(pages, 1, 1).length
  const two = pagesText(pages, 1, 2).length
  assert.equal(pagesThatFit(pages, two), 2)
  assert.equal(pagesThatFit(pages, two - 1), 1)
  assert.equal(pagesThatFit(pages, one - 1), 0)
  assert.equal(pagesThatFit(pages, 100_000), 3)
  assert.equal(pageRangeLabel('讲义', pages, 1, 3), '讲义')
  assert.equal(pageRangeLabel('讲义', pages, 2, 3), '讲义（第 2–3 页）')
})
