import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'

test('注册新账号后可以改名字、改密码，删除账号后回到登录页且无法再登录', async ({ page }) => {
  const email = `reader-${randomUUID().slice(0, 8)}@example.test`
  await page.goto('/')
  await page.getByRole('button', { name: '注册' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '注册' })).toBeFocused()
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('名字', { exact: true }).fill('小林')
  await page.getByLabel('密码', { exact: true }).fill('short')
  await page.getByRole('button', { name: '创建账号' }).click()
  await expect(page.getByLabel('密码', { exact: true })).toHaveJSProperty('validity.tooShort', true)
  await page.getByLabel('密码', { exact: true }).fill('reading-every-day-1')
  await page.getByRole('button', { name: '创建账号' }).click()
  await page.waitForURL(/#\/c\/[0-9a-f-]{36}$/u)
  const account = page.getByRole('link', { name: '账号设置：小林' })
  await expect(account).toBeVisible()

  await account.click()
  await expect(page.getByRole('heading', { level: 1, name: '账号设置' })).toBeVisible()
  await expect(page.getByText('登录邮箱：' + email)).toBeVisible()
  await page.getByRole('textbox', { name: '名字' }).fill('林同学')
  await page.getByRole('button', { name: '保存名字' }).click()
  await expect(page.getByText('名字已更新。')).toBeVisible()
  await expect(page.getByRole('link', { name: '账号设置：林同学' })).toBeVisible()

  await page.getByLabel('当前密码').fill('not-my-password')
  await page.getByLabel('新密码').fill('reading-every-day-2')
  await page.getByRole('button', { name: '修改密码' }).click()
  await expect(page.getByRole('alert')).toHaveText('密码不正确。请重新输入。')
  await expect(page.getByLabel('当前密码')).toHaveAttribute('aria-invalid', 'true')
  await page.getByLabel('当前密码').fill('reading-every-day-1')
  await page.getByRole('button', { name: '修改密码' }).click()
  await expect(page.getByText('密码已更新。其他设备上的登录已退出。')).toBeVisible()

  await page.getByRole('button', { name: '删除账号…' }).click()
  const confirm = page.getByRole('dialog', { name: '删除账号？' })
  await expect(confirm.getByLabel('密码')).toBeFocused()
  await confirm.getByLabel('密码').fill('reading-every-day-2')
  await confirm.getByRole('button', { name: '永久删除账号' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '登录' })).toBeVisible()
  await expect(page.getByText('账号已删除。感谢你使用 Human Epochs。')).toBeVisible()

  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill('reading-every-day-2')
  await page.getByRole('button', { name: '进入对话' }).click()
  await expect(page.getByRole('alert')).toHaveText('邮箱或密码有误。请核对后再登录。')
})
