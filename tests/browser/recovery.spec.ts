import { expect, test as base, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool } from '../../src/storage/database'
import { createTestUser, removeTestUser } from '../fixtures/activity'
import { startMailbox } from '../fixtures/mail'

const test = base.extend<{ user: { id: string; email: string; pool: Pool }; mailbox: Awaited<ReturnType<typeof startMailbox>> }>({
  user: async ({}, use) => {
    const pool = createPool()
    const user = await createTestUser(pool)
    try { await use({ ...user, pool }) } finally {
      try { await removeTestUser(pool, user.id) } finally { await pool.end() }
    }
  },
  mailbox: async ({}, use) => {
    const mailbox = await startMailbox()
    try { await use(mailbox) } finally { await mailbox.close() }
  },
})

const workspaceReady = async (page: Page) => {
  await page.waitForURL(/#\/c\/[0-9a-f-]{36}$/u)
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
}

test('忘记密码时通过邮件里的链接设置新密码，并直接登录', async ({ page, browser, baseURL, user, mailbox }) => {
  // Another device signed in with the old password is signed out by the reset.
  const other = await browser.newPage({ baseURL })
  await other.goto('/')
  await other.getByLabel('邮箱', { exact: true }).fill(user.email)
  await other.getByLabel('密码', { exact: true }).fill('HumanEpochs-demo-1!')
  await other.getByRole('button', { name: '进入对话' }).click()
  await workspaceReady(other)

  await page.goto('/')
  await page.getByRole('button', { name: '忘记密码？' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '找回密码' })).toBeFocused()
  await page.getByLabel('邮箱', { exact: true }).fill(user.email)
  await page.getByRole('button', { name: '发送重置邮件' }).click()
  await expect(page.getByRole('status').filter({ hasText: `如果 ${user.email} 已注册` })).toBeVisible()
  await page.getByRole('button', { name: '返回登录' }).click()
  await expect(page.getByRole('button', { name: '忘记密码？' })).toBeFocused()

  await expect.poll(() => mailbox.linkFor(user.email)).toMatch(/^http:\/\/127\.0\.0\.1:5317\/#\/reset-password\?token=/u)
  const link = mailbox.linkFor(user.email)!
  await page.goto(link)
  await expect(page.getByRole('heading', { level: 1, name: '设置新密码' })).toBeVisible()
  await page.getByLabel('新密码', { exact: true }).fill('a-brand-new-pass-1')
  await page.getByRole('button', { name: '保存新密码' }).click()
  await workspaceReady(page)

  await other.reload()
  await expect(other.getByRole('heading', { level: 1, name: '登录' })).toBeVisible()
  await other.close()

  await page.goto(link)
  await page.getByLabel('新密码', { exact: true }).fill('another-new-pass-2')
  await page.getByRole('button', { name: '保存新密码' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '链接已失效' })).toBeFocused()
})

test('注册后在侧栏提示确认邮箱，打开邮件链接后提示消失', async ({ page, mailbox }) => {
  const email = `confirm-${randomUUID().slice(0, 8)}@example.test`
  await page.goto('/')
  await page.getByRole('button', { name: '注册' }).click()
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('名字', { exact: true }).fill('小许')
  await page.getByLabel('密码', { exact: true }).fill('confirm-my-mail-1')
  await page.getByRole('button', { name: '创建账号' }).click()
  await workspaceReady(page)
  const notice = page.getByRole('link', { name: '邮箱还没有确认' })
  await expect(notice).toBeVisible()

  await notice.click()
  await expect(page.getByText('邮箱还没有确认。确认后，忘记密码时可以通过它找回。')).toBeVisible()
  await expect.poll(() => mailbox.linkFor(email)).toContain('/#/verify-email?token=')
  await page.goto(mailbox.linkFor(email)!)
  await expect(page.getByRole('heading', { level: 1, name: '邮箱已确认' })).toBeFocused()
  await page.getByRole('button', { name: '开始使用' }).click()
  await workspaceReady(page)
  await expect(page.getByRole('link', { name: '邮箱还没有确认' })).toHaveCount(0)

  await page.goto('/#/account')
  await expect(page.getByText('邮箱已确认，忘记密码时可以通过它找回。')).toBeVisible()
  await page.getByRole('button', { name: '删除账号…' }).click()
  await page.getByRole('dialog', { name: '删除账号？' }).getByLabel('密码').fill('confirm-my-mail-1')
  await page.getByRole('button', { name: '永久删除账号' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible()
})
