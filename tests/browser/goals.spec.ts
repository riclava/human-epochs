import { expect, test as base, type Page } from '@playwright/test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Pool } from 'pg'
import { agentSettingsViewSchema } from '../../src/contracts/agent-settings'
import { createPool } from '../../src/storage/database'
import { createTestUser, removeTestUser } from '../fixtures/activity'
import { modelChunk, testModelBaseUrl } from '../fixtures/conversation-stream'

const test = base.extend<{ user: { id: string; email: string; pool: Pool } }>({
  user: async ({}, use) => {
    const pool = createPool()
    const user = await createTestUser(pool)
    try { await use({ ...user, pool }) } finally {
      try { await removeTestUser(pool, user.id) } finally { await pool.end() }
    }
  },
})

const password = 'HumanEpochs-demo-1!'
const log = (page: Page) => page.getByRole('log', { name: '对话记录' })

async function signIn(page: Page, email: string) {
  await page.goto('/')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入对话' }).click()
  await page.waitForURL(/#\/c\/[0-9a-f-]{36}$/u)
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
}

test('Agent 提议的学习目标可以一键设为目标，并在学习目标页修改、暂停和删除', async ({ page, browser, baseURL, playwright, user }) => {
  const reply = '可以从等压线学起。\n\n```goal\n{"title":"看懂天气图","motivation":"想自己判断周末能不能登山"}\n```'
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(modelChunk(reply, 'stop') + 'data: [DONE]\n\n')
  })
  const { port, hostname } = new URL(testModelBaseUrl)
  const admin = await playwright.request.newContext({ baseURL })
  const { rows: [previous] } = await user.pool.query('SELECT revision, settings, connection FROM agent_settings')
  try {
    provider.listen(Number(port), hostname)
    await once(provider, 'listening')
    expect((await admin.post('/api/login', { data: { email: 'alice@example.test', password } })).ok()).toBe(true)
    const { revision, settings } = agentSettingsViewSchema.parse(await (await admin.get('/api/agent-settings')).json())
    expect((await admin.put('/api/agent-settings', { data: { expectedRevision: revision, settings, connection: {
      baseUrl: testModelBaseUrl, modelId: 'test-goal', apiKey: 'fixture-key',
    } } })).ok()).toBe(true)

    await signIn(page, user.email)
    await page.getByRole('textbox', { name: '对话消息' }).fill('我想学会看天气图，周末想自己判断能不能登山。')
    await page.getByRole('button', { name: '发送消息' }).click()
    const card = log(page).getByRole('region', { name: '看懂天气图' })
    await expect(card).toContainText('为什么想学：想自己判断周末能不能登山')
    await expect(log(page)).not.toContainText('```')
    const conversationUrl = page.url()

    // A second device sees the proposal taken once the first accepts it.
    const other = await browser.newPage({ baseURL })
    await signIn(other, user.email)
    await other.goto(conversationUrl)
    await expect(log(other).getByRole('button', { name: '设为学习目标' })).toBeVisible()
    await card.getByRole('button', { name: '设为学习目标' }).click()
    await expect(card.getByRole('status')).toHaveText('已设为学习目标。查看学习目标')
    await other.reload()
    await expect(log(other).getByRole('region', { name: '看懂天气图' })).toContainText('已设为学习目标。')
    await other.close()

    await card.getByRole('link', { name: '查看学习目标' }).click()
    await expect(page.getByRole('heading', { level: 1, name: '学习目标' })).toBeVisible()
    const active = page.getByRole('region', { name: /进行中/ })
    await expect(active.getByRole('heading', { level: 2 })).toHaveText('进行中（1/5）')
    await expect(active.getByRole('listitem')).toContainText('想自己判断周末能不能登山')

    await active.getByRole('button', { name: '修改：看懂天气图' }).click()
    await page.getByLabel('目前学到哪里（可选）').first().fill('认识了等压线和锋面符号')
    await page.getByRole('button', { name: '保存' }).click()
    await expect(active.getByRole('listitem')).toContainText('目前进展认识了等压线和锋面符号')
    await expect(active.getByRole('button', { name: '修改：看懂天气图' })).toBeFocused()

    await page.getByLabel('想学会什么').fill('学会弹吉他')
    await page.getByRole('button', { name: '添加目标' }).click()
    await expect(active.getByRole('listitem')).toHaveCount(2)
    await active.getByRole('button', { name: '暂停：学会弹吉他' }).click()
    await expect(page.getByRole('region', { name: '已暂停' }).getByRole('listitem')).toContainText('学会弹吉他')
    await expect(page.getByRole('heading', { level: 1, name: '学习目标' })).toBeFocused()
    await expect(page.getByRole('status').filter({ hasText: '「学会弹吉他」已暂停。' })).toBeAttached()

    await active.getByRole('button', { name: '删除：看懂天气图' }).click()
    const confirm = page.getByRole('dialog', { name: '删除这个目标？' })
    await confirm.getByRole('button', { name: '删除目标' }).click()
    await expect(confirm).toBeHidden()
    await expect(active).toContainText('还没有进行中的目标。')
    await expect(page.getByRole('heading', { level: 1, name: '学习目标' })).toBeFocused()

    await page.goto(conversationUrl)
    await expect(log(page).getByRole('button', { name: '设为学习目标' })).toBeVisible()
  } finally {
    provider.close()
    provider.closeAllConnections()
    await admin.dispose()
    if (previous) await user.pool.query('UPDATE agent_settings SET revision = $1, settings = $2, connection = $3', [previous.revision, previous.settings, previous.connection])
  }
})
