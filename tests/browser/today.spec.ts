import { expect, test as base, type Page } from '@playwright/test'
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

async function signIn(page: Page, email: string) {
  await page.goto('/')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill('HumanEpochs-demo-1!')
  await page.getByRole('button', { name: '进入对话' }).click()
}

test('有目标时登录后先看到今天，从目标开始的新对话归入这个目标', async ({ page, user }) => {
  await signIn(page, user.email)
  await page.waitForURL(/#\/c\/[0-9a-f-]{36}$/u)
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()

  await page.goto('/#/goals')
  await page.getByLabel('想学会什么').fill('看懂天气图')
  await page.getByRole('button', { name: '添加目标' }).click()
  await expect(page.getByText('还没有对话归入这个目标。')).toBeVisible()

  await page.goto('/')
  await expect(page).toHaveURL(/#\/today$/u)
  const goals = page.getByRole('region', { name: '进行中的目标' })
  await expect(goals.getByRole('heading', { level: 3 })).toHaveText('看懂天气图')
  await expect(goals).toContainText('还没有写下进展。')
  await goals.getByRole('button', { name: '开始学：看懂天气图' }).click()
  await expect(page).toHaveURL(/#\/c\/[0-9a-f-]{36}$/u)
  await expect(page.getByText('这段对话会归入学习目标「看懂天气图」。')).toBeVisible()
  await page.getByRole('textbox', { name: '对话消息' }).fill('从哪里开始看天气图？')
  await page.getByRole('button', { name: '发送消息' }).click()
  await expect(page.getByRole('combobox', { name: '学习目标' })).toHaveValue(/[0-9a-f-]{36}/u)

  await page.getByRole('link', { name: '今天' }).click()
  await expect(goals.getByRole('link', { name: '接着学：看懂天气图' })).toBeVisible()
  await expect(page.getByRole('region', { name: '接着聊' }).getByRole('link', { name: '从哪里开始看天气图？' })).toBeVisible()
  await goals.getByRole('link', { name: '接着学：看懂天气图' }).click()
  await expect(page.getByRole('log', { name: '对话记录' })).toContainText('从哪里开始看天气图？')
})
