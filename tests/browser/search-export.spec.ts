import { expect, test as base, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { createPool } from '../../src/storage/database'
import { createTestUser, removeTestUser } from '../fixtures/activity'

const test = base.extend<{ user: { id: string; email: string; pool: Pool } }>({
  user: async ({}, use) => {
    const pool = createPool()
    const user = await createTestUser(pool)
    try { await use({ ...user, pool }) } finally {
      try { await removeTestUser(pool, user.id) } finally { await pool.end() }
    }
  },
})

const send = (page: Page) => page.getByRole('button', { name: '发送消息' })

async function say(page: Page, text: string) {
  await page.getByRole('textbox', { name: '对话消息' }).fill(text)
  await send(page).click()
  await expect(send(page)).toBeEnabled()
}

test('搜索对话后打开匹配的那一轮，并能从账号设置下载自己的数据', async ({ page, user }) => {
  await page.goto('/')
  await page.getByLabel('邮箱', { exact: true }).fill(user.email)
  await page.getByLabel('密码', { exact: true }).fill('HumanEpochs-demo-1!')
  await page.getByRole('button', { name: '进入对话' }).click()
  await page.waitForURL(/#\/c\/[0-9a-f-]{36}$/u)
  await say(page, '我想了解冷锋过境')
  for (let index = 0; index < 6; index++) await say(page, `第 ${index + 1} 个无关问题：月亮为什么有圆缺？`)

  await page.getByRole('link', { name: '搜索对话' }).click()
  const box = page.getByRole('searchbox', { name: '搜索内容' })
  await expect(box).toBeFocused()
  await box.fill('冷锋')
  await box.press('Enter')
  await expect(page).toHaveURL(/#\/search\?q=%E5%86%B7%E9%94%8B$/u)
  await expect(page.getByRole('status').filter({ hasText: '找到 1 个对话。' })).toBeVisible()
  const results = page.getByRole('list').filter({ has: page.locator('mark') }).first()
  await expect(results.locator('mark').first()).toHaveText('冷锋')

  await page.getByRole('link', { name: /你的消息.*我想了解冷锋过境/u }).click()
  await expect(page).toHaveURL(/#\/c\/[0-9a-f-]{36}\/t\/[0-9a-f-]{36}$/u)
  const target = page.locator('.conversation-turn.is-target')
  await expect(target).toContainText('我想了解冷锋过境')
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport()

  await page.goBack()
  await expect(page.getByRole('searchbox', { name: '搜索内容' })).toHaveValue('冷锋')
  await page.getByRole('searchbox', { name: '搜索内容' }).fill('海王星')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '没有找到包含「海王星」的对话。' })).toBeVisible()

  await page.goto('/#/account')
  const downloading = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载我的数据' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^human-epochs-\d{4}-\d{2}-\d{2}\.json$/u)
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'))
  expect(data.account.email).toBe(user.email)
  expect(data.conversations[0].turns[0].message).toBe('我想了解冷锋过境')
})
