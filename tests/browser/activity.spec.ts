import { expect, test as base, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { chatContentText, type ChatSnapshot, type ChatTurn } from '../../src/contracts/chat'
import { agentSettingsViewSchema } from '../../src/contracts/agent-settings'
import { ActivityViewSchema } from '../../src/contracts/learning'
import { memoirCourse } from '../../src/curriculum/catalog'
import { createPool } from '../../src/storage/database'
import { inTransaction } from '../../src/storage/transaction'
import { createActivity } from '../../src/activities/activities'
import { createTestLearner, removeTestLearner } from '../fixtures/activity'
import { chatCitations, modelChunk, readChatTurn, testModelBaseUrl } from '../fixtures/chat-stream'

const test = base.extend<{ learner: { id: string; email: string; pool: Pool }; phone: Page }>({
  learner: async ({}, use) => {
    const pool = createPool()
    const learner = await createTestLearner(pool)
    try { await use({ ...learner, pool }) } finally {
      try { await removeTestLearner(pool, learner.id) } finally { await pool.end() }
    }
  },
  phone: async ({ browser, baseURL }, use) => {
    const phone = await browser.newPage({ baseURL, viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true })
    try { await use(phone) } finally { await phone.close() }
  },
})

const password = 'HumanEpochs-demo-1!'
const composer = (page: Page) => page.getByRole('textbox', { name: '对话消息' })
const send = (page: Page) => page.getByRole('button', { name: '发送消息' })
const log = (page: Page) => page.getByRole('log', { name: '学习对话' })

async function signIn(page: Page, email: string, path = '/') {
  await page.goto(path)
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '进入学习空间' }).click()
  await expect(page.getByRole('heading', { level: 1, name: '学习空间' })).toBeVisible()
  await expect(send(page)).toBeEnabled()
}

async function expectTextWorkspace(page: Page) {
  const main = page.getByRole('main', { name: '学习空间' })
  await expect(main.getByRole('textbox')).toHaveCount(1)
  await expect(composer(page)).toBeInViewport()
  await expect(main.getByRole('combobox')).toHaveCount(0)
  await expect(main.getByRole('spinbutton')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /领取提示|开始练习|补充材料/ })).toHaveCount(0)
  await expect(page.locator('a[href*="#/activities/"]')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

async function sendText(page: Page, text: string): Promise<ChatTurn> {
  await composer(page).fill(text)
  const response = page.waitForResponse(r => r.url().endsWith('/api/chat') && r.request().method() === 'POST')
  await send(page).click()
  const receipt = await response
  expect(receipt.status()).toBe(200)
  await expect(send(page)).toBeEnabled()
  const snapshot: ChatSnapshot = await (await page.request.get('/api/chat')).json()
  const turn = snapshot.turns.at(-1)!
  expect(turn).toMatchObject({ text, status: 'complete' })
  expect(chatContentText(turn.content)).toBeTruthy()
  await expect(log(page).getByText(text, { exact: true })).toHaveCount(1)
  await expect(log(page)).toContainText(chatContentText(turn.content)!)
  return turn
}

test('管理员可在桌面与窄屏修改运行设置，学习者无法进入设置页', async ({ page, phone }) => {
  await signIn(page, 'alice@example.test')
  await page.getByRole('link', { name: '运行设置' }).press('Enter')
  const settings = page.getByRole('main', { name: '运行设置' })
  await expect(settings).toBeFocused()
  for (const section of ['模型连接', '模型生成', '上下文与材料', '执行预算']) {
    await expect(settings.getByRole('region', { name: section })).toBeVisible()
  }
  const output = settings.getByRole('spinbutton', { name: '输出上限' })
  await expect(output).toHaveValue('393216')
  await output.fill('400000')
  const save = settings.getByRole('button', { name: '保存设置' })
  await save.press('Enter')
  await expect(output).toBeFocused()
  await expect(output).toHaveAccessibleDescription(/请输入范围内的整数/)
  await output.fill('3072')
  await save.click()
  await expect(settings.getByRole('status')).toHaveText('设置已保存。')

  await signIn(phone, 'alice@example.test')
  await phone.getByRole('button', { name: '展开学习导航' }).click()
  await phone.getByRole('link', { name: '运行设置' }).click()
  const mobileSettings = phone.getByRole('main', { name: '运行设置' })
  await expect(mobileSettings.getByRole('spinbutton', { name: '输出上限' })).toHaveValue('3072')
  expect(await phone.evaluate(() => {
    const pane = document.querySelector('.settings-pane')!
    return pane.scrollWidth <= pane.clientWidth && document.documentElement.scrollWidth <= innerWidth
  })).toBe(true)
  await mobileSettings.getByRole('button', { name: '使用默认值' }).click()
  await mobileSettings.getByRole('button', { name: '保存设置' }).click()
  await expect(mobileSettings.getByRole('status')).toHaveText('设置已保存。')

  await page.getByRole('button', { name: '退出', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  await signIn(page, 'bob@example.test', '/#/settings')
  await expect(page.getByRole('link', { name: '运行设置' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '学习空间', exact: true })).toBeVisible()
})

test('AI 设置助手支持追问，建议先填入表单再由管理员保存', async ({ page }) => {
  const conversations: { history: { role: string; content: string }[] }[] = []
  await page.route('**/api/agent-settings', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const snapshot = await response.json()
    await route.fulfill({ response, json: { ...snapshot, assistantAvailable: true } })
  })
  await page.route('**/api/agent-settings/assistant', async route => {
    conversations.push(route.request().postDataJSON())
    await route.fulfill({ json: { reply: '可以把单次模型超时调到 30 秒。', changes: { modelTimeoutSeconds: 30 } } })
  })
  await signIn(page, 'alice@example.test')
  await page.getByRole('link', { name: '运行设置' }).click()
  const settings = page.getByRole('main', { name: '运行设置' })
  await settings.getByText('AI 设置助手', { exact: true }).click()
  const question = settings.getByRole('textbox', { name: '设置问题' })
  const sendQuestion = settings.getByRole('button', { name: '发送问题' })
  const timeout = settings.getByRole('spinbutton', { name: '单次模型超时' })
  await question.fill('能缩短等待时间吗？')
  await sendQuestion.click()
  const advice = settings.getByRole('log', { name: '设置对话' })
  await expect(advice).toContainText('单次模型超时 45 → 30 秒')
  await expect(timeout).toHaveValue('45')
  await question.fill('这个值怎么应用？')
  await sendQuestion.click()
  await expect(advice.getByRole('button', { name: '填入表单' })).toHaveCount(2)
  expect(conversations[1].history.map(item => item.role)).toEqual(['user', 'assistant', 'user'])
  expect(JSON.parse(conversations[1].history[1].content).changes).toEqual({ modelTimeoutSeconds: 30 })
  await advice.getByRole('button', { name: '填入表单' }).last().click()
  await expect(timeout).toHaveValue('30')
  expect((await (await page.request.get('/api/agent-settings')).json()).settings.modelTimeoutSeconds).toBe(45)
  await settings.getByRole('button', { name: '保存设置' }).click()
  await expect(settings.getByRole('status')).toHaveText('设置已保存。')
  expect((await (await page.request.get('/api/agent-settings')).json()).settings.modelTimeoutSeconds).toBe(30)
})

test('模型连接直接配置 Base URL 和 API Key，重新打开时密钥字段为空', async ({ page, phone }) => {
  const pool = createPool()
  try {
    await signIn(page, 'alice@example.test')
    await page.getByRole('link', { name: '运行设置' }).click()
    const connection = page.getByRole('region', { name: '模型连接' })
    const address = connection.getByLabel('Base URL')
    const key = connection.getByLabel('API Key')
    const model = connection.getByLabel('模型 ID')
    await expect(connection.getByRole('combobox')).toHaveCount(0)
    await address.fill('https://example.test/v1')
    await model.fill('study-model')
    const save = page.getByRole('button', { name: '保存设置' })
    await save.click()
    await expect(key).toBeFocused()
    await expect(key).toHaveAccessibleDescription(/更换 Base URL/)
    await key.fill('demo-settings-key')
    await save.click()
    await expect(page.getByRole('main').getByRole('status')).toHaveText('设置已保存。')
    await expect(key).toHaveValue('')
    await expect(key).toHaveAccessibleDescription(/已配置/)

    await signIn(phone, 'alice@example.test')
    await phone.getByRole('button', { name: '展开学习导航' }).click()
    await phone.getByRole('link', { name: '运行设置' }).click()
    const mobile = phone.getByRole('region', { name: '模型连接' })
    await expect(mobile.getByLabel('Base URL')).toHaveValue('https://example.test/v1')
    await expect(mobile.getByLabel('模型 ID')).toHaveValue('study-model')
    await expect(mobile.getByLabel('API Key')).toHaveValue('')
    await expect(mobile.getByLabel('API Key')).toHaveAccessibleDescription(/已配置/)
    expect(await mobile.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  } finally {
    await pool.query('DELETE FROM agent_settings')
    await pool.end()
  }
})

test('登录错误关联到凭据输入框，纠正后进入学习空间', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('登录 · Human Epochs')
  const email = page.getByLabel('邮箱', { exact: true })
  const passwordField = page.getByLabel('密码', { exact: true })
  await email.fill('alice@example.test')
  await passwordField.fill('incorrect-demo-password')
  await passwordField.press('Enter')
  await expect(page.getByRole('alert')).toContainText('邮箱或密码')
  for (const field of [email, passwordField]) {
    await expect(field).toHaveAccessibleDescription(/邮箱或密码/)
    await expect(field).toHaveAttribute('aria-invalid', 'true')
  }
  await passwordField.fill(password)
  await expect(page.getByRole('alert')).toHaveCount(0)
  for (const field of [email, passwordField]) {
    await expect(field).not.toHaveAttribute('aria-invalid', 'true')
  }
  await passwordField.press('Enter')
  await expect(page).toHaveTitle('学习空间 · Human Epochs')
})

test('桌面与窄屏手机通过同一个文字输入框接续学习对话', async ({ page, phone, learner }) => {
  await signIn(page, learner.email)
  await expectTextWorkspace(page)
  const first = await sendText(page, '我想学写诗。')
  await signIn(phone, learner.email)
  await expect(log(phone)).toContainText(chatContentText(first.content)!)
  await expectTextWorkspace(phone)
  const toggle = phone.getByRole('button', { name: '展开学习导航' })
  await toggle.press('Enter')
  const home = phone.getByRole('link', { name: '学习空间', exact: true })
  await home.press('Escape')
  await expect(toggle).toBeFocused()
  await toggle.press('Enter')
  await home.press('Enter')
  await expect(phone.getByRole('main', { name: '学习空间' })).toBeFocused()

  const followUp = await sendText(phone, '我想写一首送给朋友的短诗。')
  await page.reload()
  await expect(log(page)).toContainText(chatContentText(followUp.content)!)
  await expect(log(page).getByText(followUp.text, { exact: true })).toHaveCount(1)
  await expectTextWorkspace(phone)
})

test('回复在途中丢失后，两端恢复同一条已收件的消息', async ({ page, phone, learner }) => {
  await signIn(page, learner.email)
  let requestId: string | undefined
  await page.route('**/api/chat', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    requestId = route.request().postDataJSON().requestId
    const received = await route.fetch()
    expect(received.status()).toBe(200)
    await route.abort('connectionreset')
  })
  const question = '我想了解潮汐的周期。'
  const restored = page.waitForResponse(r => r.url().endsWith('/api/chat') && r.request().method() === 'GET')
  await composer(page).fill(question)
  await composer(page).press('Enter')
  expect((await restored).status()).toBe(200)
  await expect(log(page).getByText(question, { exact: true })).toHaveCount(1)
  await signIn(phone, learner.email)
  const snapshot: ChatSnapshot = await (await phone.request.get('/api/chat')).json()
  expect(snapshot.turns).toHaveLength(1)
  const [turn] = snapshot.turns
  expect(turn).toMatchObject({ requestId, text: question })
  expect(chatContentText(turn.content)).toBeTruthy()
  for (const device of [page, phone]) {
    await expect(log(device)).toContainText(chatContentText(turn.content)!)
    await expect(log(device).getByText(question, { exact: true })).toHaveCount(1)
    await expect(composer(device)).toHaveValue('')
  }
})

test('消息未送达时保留原文，重新发送复用原请求 ID', async ({ page, learner }) => {
  await signIn(page, learner.email)
  const ids: string[] = []
  await page.route('**/api/chat', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    ids.push(route.request().postDataJSON().requestId)
    if (ids.length === 1) return route.abort('connectionreset')
    return route.continue()
  })
  const question = '云是怎样形成的？'
  await composer(page).fill(question)
  await send(page).click()
  await expect(page.getByRole('alert')).toContainText('暂时无法确认回复')
  await expect(composer(page)).toHaveValue(question)
  await page.reload()
  await expect(composer(page)).toHaveValue(question)
  const received = page.waitForResponse(r => r.url().endsWith('/api/chat') && r.request().method() === 'POST')
  await send(page).click()
  expect((await received).status()).toBe(200)
  await expect(log(page).getByText(question, { exact: true })).toHaveCount(1)
  await expect(composer(page)).toHaveValue('')
  const snapshot: ChatSnapshot = await (await page.request.get('/api/chat')).json()
  expect(snapshot.turns).toHaveLength(1)
  expect(ids).toEqual([snapshot.turns[0].requestId, snapshot.turns[0].requestId])
})

test('同浏览器退出及更换账号后隔离对话，另一台设备仍能续读', async ({ page, phone, learner }) => {
  await signIn(page, learner.email)
  const turn = await sendText(page, '我想讨论只有我自己记下的一次月食观测。')
  await signIn(phone, learner.email)
  const otherTab = await page.context().newPage()
  await otherTab.goto('/')
  await expect(log(otherTab)).toContainText(turn.text)
  await page.getByRole('button', { name: '退出', exact: true }).click()
  const loginHeading = page.getByRole('heading', { name: '登录', exact: true })
  await expect(loginHeading).toBeFocused()
  await expect(otherTab.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  expect((await otherTab.request.get('/api/chat')).status()).toBe(401)
  await signIn(page, 'bob@example.test')
  await expect(otherTab.getByText('Bob', { exact: true })).toBeVisible()
  await expect(send(otherTab)).toBeEnabled()
  for (const tab of [page, otherTab]) {
    await expect(log(tab)).not.toContainText(turn.text)
  }
  await phone.reload()
  await expect(log(phone)).toContainText(turn.text)
})

test('两端可以读取同一项活动的已领提示', async ({ page, phone, learner }) => {
  const created = await inTransaction(learner.pool, db => createActivity(db, learner.id, memoirCourse.version))
  if (!created) throw new Error('Expected a published activity')
  const path = '/api/activities/' + created.activityId
  await signIn(page, learner.email)
  const activity = ActivityViewSchema.parse(await (await page.request.get(path)).json())
  const result = await page.request.post(path + '/hints', {
    data: { activityId: activity.activityId, revision: activity.revision, commandId: randomUUID() },
  })
  expect(result.status()).toBe(200)
  await signIn(phone, learner.email)
  const observed = ActivityViewSchema.parse(await (await phone.request.get(path)).json())
  expect(observed).toEqual((await result.json()).activity)
  expect(observed.hints).toEqual(memoirCourse.privateContent.hints)

  expect((await page.request.get('/@fs/' + resolve('src/curriculum/catalog.ts'))).status()).toBe(403)
  await page.getByRole('button', { name: '退出', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  await signIn(page, 'bob@example.test')
  expect((await page.request.get(path)).status()).toBe(404)
})

test('旧材料对话保留引用，重新进入后仍可用文字继续讨论', async ({ page, phone, learner }) => {
  await signIn(page, learner.email)
  const excerpt = { label: '气象笔记', text: '九点测得树荫下的气温为二十度。' }
  const saved = await page.request.post('/api/chat', { data: {
    requestId: randomUUID(), text: '笔记里记下了什么气温？', material: { excerpt },
  } })
  expect(saved.status()).toBe(200)
  const turn = await readChatTurn(await saved.text(), saved.headers()['content-type'])
  expect(chatCitations(turn.content)).toContainEqual(expect.objectContaining({ label: excerpt.label, quote: excerpt.text }))
  await signIn(phone, learner.email)
  await expect(log(phone).getByLabel('引用原文')).toContainText(excerpt.text)
  await expectTextWorkspace(phone)
  const next = await sendText(phone, '我想了解温度计的原理。')
  await page.reload()
  await expect(log(page)).toContainText(chatContentText(next.content)!)
  await expect(log(page).getByLabel('引用原文')).toContainText(excerpt.text)
})

test('Markdown 在模型完成前显示，失败片段可重试，已发布回复可跨端恢复', async ({ page, phone, learner, playwright, baseURL }) => {
  let finishFirst!: () => void
  const firstGate = new Promise<void>(resolve => { finishFirst = resolve })
  let finishSecond!: () => void
  const secondGate = new Promise<void>(resolve => { finishSecond = resolve })
  const answerStart = '# 先看月相 🌙\n\n- **第一步**\n'
  const longCode = 'moonPhase'.repeat(50)
  const answerEnd = '\n```text\n' + longCode + '\n```\n\n[资料](https://example.test/moon) [无效链接](javascript:alert%281%29)' +
    '\n\n<img src="/hidden.png" />\n\n![图示说明](/remote.png)'
  let calls = 0
  let stoppedConnection = false
  const provider = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.url !== '/chat/completions' || JSON.parse(body).stream !== true) {
      response.writeHead(400).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (++calls === 1) {
      response.write(modelChunk('**尚未完成的解释**'))
      await firstGate
      response.end()
      return
    }
    if (calls === 3) {
      response.once('close', () => { stoppedConnection = true })
      response.write(modelChunk('这段生成将被停止。'))
      return
    }
    const chunk = Buffer.from(modelChunk(answerStart))
    const split = chunk.indexOf(Buffer.from('🌙')) + 1
    response.write(chunk.subarray(0, split))
    response.write(chunk.subarray(split))
    await secondGate
    response.end(modelChunk(answerEnd, 'stop') + 'data: [DONE]\n\n')
  })
  const { port, hostname } = new URL(testModelBaseUrl)
  const admin = await playwright.request.newContext({ baseURL })
  const { rows: [previous] } = await learner.pool.query('SELECT revision, settings FROM agent_settings')
  try {
    provider.listen(Number(port), hostname)
    await once(provider, 'listening')
    expect((await admin.post('/api/login', { data: { email: 'alice@example.test', password } })).ok()).toBe(true)
    const path = '/api/agent-settings'
    const { revision, settings } = agentSettingsViewSchema.parse(await (await admin.get(path)).json())
    const configured = await admin.put(path, { data: { revision, settings: { ...settings, maxOutputTokens: 1024 }, connection: {
      baseUrl: testModelBaseUrl, modelId: 'test-stream', apiKey: 'fixture-key',
    } } })
    expect(configured.ok()).toBe(true)
    await signIn(phone, learner.email)
    const question = '怎样观察月相？'
    await composer(phone).fill(question)
    await send(phone).click()
    const draftReply = log(phone).getByText('尚未完成的解释', { exact: true })
    await expect(draftReply).toBeVisible()
    const pending: ChatSnapshot = await (await phone.request.get('/api/chat')).json()
    expect(pending.turns).toEqual([expect.objectContaining({ text: question, status: 'pending', content: null })])
    finishFirst()
    const retry = log(phone).getByRole('button', { name: '重试回复' })
    await expect(retry).toBeEnabled()
    await expect(draftReply).toHaveCount(0)

    await retry.click()
    await expect(log(phone).getByRole('heading', { level: 2, name: '先看月相 🌙' })).toBeVisible()
    await expect(log(phone).locator('li strong')).toHaveText('第一步')
    await expect(phone.getByRole('button', { name: '停止回复' })).toBeEnabled()
    finishSecond()
    await expect(send(phone)).toBeEnabled()
    await expect(log(phone).locator('pre code')).toHaveText(longCode)
    await expect(log(phone).getByRole('link', { name: '资料' })).toHaveAttribute('href', 'https://example.test/moon')
    await expect(log(phone)).toContainText('无效链接')
    await expect(log(phone).getByRole('link', { name: '无效链接' })).toHaveCount(0)
    await expect(log(phone).locator('img')).toHaveCount(0)
    await expectTextWorkspace(phone)
    expect(await log(phone).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)

    await signIn(page, learner.email)
    await expect(log(page).getByRole('heading', { level: 2, name: '先看月相 🌙' })).toBeVisible()
    const published: ChatSnapshot = await (await page.request.get('/api/chat')).json()
    expect(published.turns).toEqual([{ ...pending.turns[0], status: 'complete', content: [{ id: expect.any(String), kind: 'text', text: answerStart + answerEnd }] }])

    await composer(phone).fill('还能观察什么？')
    await send(phone).click()
    const partial = log(phone).getByText('这段生成将被停止。', { exact: true })
    await expect(partial).toBeVisible()
    await page.reload()
    const stop = page.getByRole('button', { name: '停止回复' })
    await expect(stop).toBeEnabled()
    await stop.press('Enter')
    await expect(composer(page)).toBeFocused()
    for (const device of [page, phone]) {
      await expect(log(device)).toContainText('已停止回复。')
      await expect(send(device)).toBeEnabled()
    }
    await expect(partial).toHaveCount(0)
    await expect.poll(() => stoppedConnection).toBe(true)
    const restored: ChatSnapshot = await (await phone.request.get('/api/chat')).json()
    expect(restored.turns.at(-1)).toMatchObject({ text: '还能观察什么？', status: 'stopped', content: null })
    expect(calls).toBe(3)
  } finally {
    finishFirst()
    finishSecond()
    provider.close()
    provider.closeAllConnections()
    await admin.dispose()
    if (previous) await learner.pool.query('UPDATE agent_settings SET revision = $1, settings = $2', [previous.revision, previous.settings])
    else await learner.pool.query('DELETE FROM agent_settings')
  }
})

test('两端能查看来源、修改授权并忘记个人记忆', async ({ page, phone, learner }) => {
  await signIn(page, learner.email)
  await sendText(page, '我想先学会看星图。')
  await log(page).getByRole('link', { name: '保存到个人记忆' }).click()
  const body = page.getByRole('textbox', { name: '记忆内容' })
  await expect(body).toHaveValue('我想先学会看星图。')
  await page.getByLabel('允许用于学习辅导').check()
  await page.getByRole('button', { name: '保存记忆' }).click()
  await expect(page.getByRole('region', { name: '已保存的记忆' })).toContainText('已授权学习辅导')
  await expect(page.getByRole('link', { name: '查看来源消息' })).toBeVisible()

  await signIn(phone, learner.email)
  await phone.getByRole('button', { name: '展开学习导航' }).click()
  await phone.getByRole('link', { name: '个人记忆', exact: true }).click()
  await phone.getByRole('button', { name: '纠正', exact: true }).click()
  await phone.getByRole('textbox', { name: '记忆内容' }).fill('我想先练习辨认北斗。')
  await phone.getByLabel('允许用于学习辅导').uncheck()
  await phone.getByRole('button', { name: '保存记忆' }).click()
  const saved = phone.getByRole('region', { name: '已保存的记忆' })
  await expect(saved).toContainText('仅供回看')
  await expect(saved).toContainText('我想先练习辨认北斗。')
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await phone.getByRole('button', { name: '忘记', exact: true }).click()
  await expect(phone.getByRole('dialog')).toBeVisible()
  await phone.getByRole('dialog').getByRole('button', { name: '忘记记忆' }).click()
  await expect(saved).toContainText('还没有个人记忆')
  await page.reload()
  await expect(page.getByRole('region', { name: '已保存的记忆' })).toContainText('还没有个人记忆')
})
