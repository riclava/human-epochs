import { expect, test as base } from '@playwright/test'
import { createECDH, randomBytes, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { createPool } from '../../src/storage/database'
import { createTestUser, removeTestUser } from '../fixtures/activity'
import { startPushService, testPushOrigin } from '../fixtures/push'
import { agentSettingsViewSchema } from '../../src/contracts/agent-settings'
import { testModelBaseUrl } from '../fixtures/conversation-stream'
import { once } from 'node:events'
import { createServer } from 'node:http'

const test = base.extend<{ user: { id: string; email: string; pool: Pool } }>({
  user: async ({}, use) => {
    const pool = createPool()
    const user = await createTestUser(pool)
    try { await use({ ...user, pool }) } finally {
      try { await removeTestUser(pool, user.id) } finally { await pool.end() }
    }
  },
})

test('应用可以安装，开启复习提醒后到期的复习会推送到这台设备', async ({ page, user, request, playwright, baseURL }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json()
  expect(manifest).toMatchObject({ name: 'Human Epochs', display: 'standalone', start_url: '/' })
  expect((await request.get('/offline.html')).ok()).toBe(true)

  // Headless Chromium cannot reach a real push service and reports notifications as denied even when granted, so the
  // browser's permission and subscription are replaced: permission starts undecided and the subscription goes to the
  // fake push service. Everything from the button to the server's delivery is real.
  const browserKey = createECDH('prime256v1')
  browserKey.generateKeys()
  const fake = { endpoint: `${testPushOrigin}/push/${randomUUID()}`, expirationTime: null,
    keys: { p256dh: browserKey.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  await page.addInitScript(subscription => {
    let permission: NotificationPermission = 'default'
    Object.defineProperty(Notification, 'permission', { get: () => permission })
    Notification.requestPermission = async () => (permission = 'granted')
    let current: unknown = null
    const make = () => ({ endpoint: subscription.endpoint, toJSON: () => subscription, unsubscribe: async () => { current = null; return true } })
    PushManager.prototype.getSubscription = async function () { return current as PushSubscription | null }
    PushManager.prototype.subscribe = async function () { current = make(); return current as PushSubscription }
  }, fake)
  // A model that explains the course with a citation and schedules a review, which is what the reminder announces.
  const provider = createServer(async (incoming, response) => {
    let body = ''
    for await (const chunk of incoming) body += chunk
    const prompt = JSON.parse(JSON.parse(body).messages.at(-1).content)
    const source = prompt.sources[0]
    const reply = JSON.stringify({ blocks: [{ kind: 'text', text: '这是转述。', citations: [{ sourceId: source.id, quote: source.text }] }],
      review: { topic: '亲历和转述', question: '转述能证明亲历吗？', answer: '不能。', afterDays: 2, sourceId: source.id, quote: source.text } })
    // Material explanations are requested as one JSON reply, not a stream.
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: reply } }] }))
  })
  const { port, hostname } = new URL(testModelBaseUrl)
  provider.listen(Number(port), hostname)
  await once(provider, 'listening')
  const admin = await playwright.request.newContext({ baseURL })
  const { rows: [previous] } = await user.pool.query('SELECT revision, settings, connection FROM agent_settings')
  const service = await startPushService()
  try {
    expect((await admin.post('/api/login', { data: { email: 'alice@example.test', password: 'HumanEpochs-demo-1!' } })).ok()).toBe(true)
    const { revision, settings } = agentSettingsViewSchema.parse(await (await admin.get('/api/agent-settings')).json())
    expect((await admin.put('/api/agent-settings', { data: { expectedRevision: revision, settings, connection: {
      baseUrl: testModelBaseUrl, modelId: 'test-reminder', apiKey: 'fixture-key' } } })).ok()).toBe(true)
    await page.goto('/')
    await page.getByLabel('邮箱', { exact: true }).fill(user.email)
    await page.getByLabel('密码', { exact: true }).fill('HumanEpochs-demo-1!')
    await page.getByRole('button', { name: '进入对话' }).click()
    await page.waitForURL(/#\/c\/[0-9a-f-]{36}$/u)
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.active)).toBe(true)

    await page.goto('/#/account')
    const reminders = page.getByRole('region', { name: '复习提醒' })
    await expect(reminders.getByRole('status')).toHaveText('这台设备还没有开启复习提醒。')
    await reminders.getByRole('button', { name: '在这台设备上开启' }).click()
    await expect(reminders.getByRole('status')).toHaveText('这台设备会在复习到期时收到通知。')
    await expect.poll(async () => (await user.pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [user.id])).rowCount).toBe(1)

    // Start a discussion so a review is scheduled, then make it due; the server's background job sends the reminder.
    await page.getByRole('link', { name: '对话', exact: true }).click()
    await page.getByRole('button', { name: /^聊聊《/u }).click()
    await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled()
    await expect(page.getByRole('log', { name: '对话记录' })).toContainText('这是转述。')
    const due = await user.pool.query(`UPDATE review_invitations SET due_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id])
    expect(due.rowCount).toBe(1)
    await expect.poll(() => service.received.length, { timeout: 10_000 }).toBe(1)
    expect(service.received[0]).toMatchObject({ path: new URL(fake.endpoint).pathname, encoding: 'aes128gcm' })
    expect(service.received[0]!.authorization).toMatch(/^vapid t=/u)

    await page.goto('/#/account')
    await reminders.getByRole('button', { name: '在这台设备上关闭' }).click()
    await expect(reminders.getByRole('status')).toHaveText('这台设备还没有开启复习提醒。')
    expect((await user.pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [user.id])).rowCount).toBe(0)
  } finally {
    await service.close()
    provider.close()
    provider.closeAllConnections()
    await admin.dispose()
    // Put the runtime settings back, removing them when this test created them, so later tests run offline.
    if (previous) await user.pool.query('UPDATE agent_settings SET revision = $1, settings = $2, connection = $3', [previous.revision, previous.settings, previous.connection])
    else await user.pool.query('DELETE FROM agent_settings')
  }
})
