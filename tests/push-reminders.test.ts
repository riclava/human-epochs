import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, verify } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { test } from 'node:test'
import { createApp } from '../src/app/create-app.js'
import { pushEndpointAllowed, processNextPushReminder, type PushSettings } from '../src/app/push-reminders.js'
import { encryptPushMessage, generateVapidKeys, vapidAuthorization } from '../src/app/web-push.js'
import type { MaterialPrompt } from '../src/runtime/model.js'
import { createTestUser, removeTestUser } from './fixtures/activity.js'
import { readConversationTurn } from './fixtures/conversation-stream.js'
import { login, useTestDatabase } from './fixtures/test-database.js'

const pool = useTestDatabase()
const b64 = (value: string) => Buffer.from(value, 'base64url')

// What a browser does with a received message: RFC 8291 in reverse.
function decrypt(body: Buffer, browser: ReturnType<typeof createECDH>, auth: Buffer) {
  const salt = body.subarray(0, 16)
  const keyLength = body.readUInt8(20)
  const senderPublic = body.subarray(21, 21 + keyLength)
  const shared = browser.computeSecret(senderPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser.getPublicKey(), senderPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, info, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const record = body.subarray(21 + keyLength)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(record.subarray(-16))
  const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()])
  assert.equal(plain.at(-1), 2, 'a single record ends with the 0x02 delimiter')
  return plain.subarray(0, -1)
}

test('messages are encrypted as RFC 8291 specifies and requests carry a valid VAPID signature', () => {
  // RFC 8291, Appendix A.
  const sender = createECDH('prime256v1')
  sender.setPrivateKey(b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'))
  const body = encryptPushMessage(Buffer.from('When I grow up, I want to be a watermelon'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { ecdh: sender, salt: b64('DGv6ra1nlYgDCS1FRnbzlw') })
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')

  const keys = { ...generateVapidKeys(), subject: 'mailto:owner@learn.example' }
  const now = Date.UTC(2026, 10, 28)
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, now)
  const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/u.exec(header)!
  assert.equal(publicKey, keys.publicKey)
  const [head, payload, signature] = token!.split('.')
  assert.deepEqual(JSON.parse(b64(payload!).toString()), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:owner@learn.example' })
  const point = b64(keys.publicKey)
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') } })
  assert.ok(verify('sha256', Buffer.from(`${head}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }, b64(signature!)))
})

test('only browser push services and configured origins are accepted as endpoints', () => {
  assert.ok(pushEndpointAllowed('https://fcm.googleapis.com/fcm/send/x', []))
  assert.ok(pushEndpointAllowed('https://updates.push.services.mozilla.com/wpush/v2/x', []))
  assert.ok(pushEndpointAllowed('https://web.push.apple.com/x', []))
  assert.ok(!pushEndpointAllowed('http://fcm.googleapis.com/x', []), 'not over plain HTTP')
  assert.ok(!pushEndpointAllowed('https://fcm.googleapis.com.evil.example/x', []))
  assert.ok(!pushEndpointAllowed('https://169.254.169.254/latest', []))
  assert.ok(!pushEndpointAllowed('https://fcm.googleapis.com:8443/x', []))
  assert.ok(pushEndpointAllowed('http://127.0.0.1:3319/push/x', ['http://127.0.0.1:3319']))
})

test('a due review is announced once to each device, and gone or signed-out devices are forgotten', { timeout: 20_000 }, async t => {
  const received: { url: string; headers: IncomingHttpHeaders; body: Buffer }[] = []
  let answer = 201
  const service = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    received.push({ url: request.url!, headers: request.headers, body: Buffer.concat(chunks) })
    response.writeHead(answer).end()
  })
  service.listen(0, '127.0.0.1')
  await once(service, 'listening')
  t.after(() => service.close())
  const origin = `http://127.0.0.1:${(service.address() as { port: number }).port}`
  const push: PushSettings = { vapid: { ...generateVapidKeys(), subject: 'mailto:owner@learn.example' }, allowedOrigins: [origin] }

  const user = await createTestUser(pool)
  t.after(() => removeTestUser(pool, user.id))
  let time = Date.now()
  const now = () => new Date(time)
  const server = createApp(pool, async ({ messages }) => {
    const prompt: MaterialPrompt = JSON.parse(String(messages.at(-1)!.content))
    const sourceId = prompt.sources[0]!.id
    const quote = '冷锋过境时气温下降'
    return { kind: 'text', text: JSON.stringify({ blocks: [{ kind: 'text', text: '看原文。', citations: [{ sourceId, quote }] }],
      review: { topic: '冷锋过境', question: '冷锋过境时气温怎么变？', answer: '下降。', afterDays: 2, sourceId, quote } }) }
  }, undefined, undefined, { reviewNow: now, push })
  t.after(() => server.close())
  const phone = await login(server, user.email)
  const laptop = await login(server, user.email)
  assert.deepEqual((await server.inject({ url: '/api/push', headers: { cookie: phone } })).json(), { available: true, publicKey: push.vapid.publicKey })

  const browsers = [phone, laptop].map(cookie => {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = randomBytes(16)
    return { cookie, ecdh, auth, endpoint: `${origin}/push/${randomUUID()}` }
  })
  for (const browser of browsers) {
    const response = await server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { cookie: browser.cookie }, payload: {
      endpoint: browser.endpoint, expirationTime: null, keys: { p256dh: browser.ecdh.getPublicKey().toString('base64url'), auth: browser.auth.toString('base64url') } } })
    assert.equal(response.statusCode, 204, response.payload)
  }
  const refused = await server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { cookie: phone }, payload: {
    endpoint: 'https://attacker.example/collect', keys: { p256dh: browsers[0]!.ecdh.getPublicKey().toString('base64url'), auth: browsers[0]!.auth.toString('base64url') } } })
  assert.equal(refused.statusCode, 400, 'an endpoint outside the push services is refused')

  const response = await server.inject({ method: 'POST', url: '/api/conversation', headers: { cookie: phone },
    payload: { conversationId: randomUUID(), requestId: randomUUID(), messageText: '冷锋过境会怎样？',
      materialSelection: { excerpt: { label: '锋面笔记', text: '冷锋过境时气温下降、气压上升。' } } } })
  await readConversationTurn(response.payload, String(response.headers['content-type']))
  assert.equal(await processNextPushReminder(pool, push, now), false, 'nothing is due yet')

  time += 49 * 3_600_000
  assert.equal(await processNextPushReminder(pool, push, now), true)
  assert.deepEqual(received.map(item => item.url).sort(), browsers.map(browser => new URL(browser.endpoint).pathname).sort(), 'every device hears once')
  for (const item of received) {
    const browser = browsers.find(candidate => new URL(candidate.endpoint).pathname === item.url)!
    assert.equal(item.headers['content-encoding'], 'aes128gcm')
    assert.match(String(item.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/u)
    const message = JSON.parse(decrypt(item.body, browser.ecdh, browser.auth).toString())
    assert.deepEqual(message, { title: '该复习了', body: '「冷锋过境」到复习时间了，回来试一题吧。', url: '/#/today', tag: message.tag })
  }
  assert.equal(await processNextPushReminder(pool, push, now), false, 'a review is announced only once')

  // A device the push service reports as gone is forgotten; signing out forgets that session's device.
  await pool.query('UPDATE review_invitations SET notified_at = NULL WHERE user_id = $1', [user.id])
  answer = 410
  received.length = 0
  await processNextPushReminder(pool, push, now)
  assert.equal(received.length, 2)
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [user.id])).rowCount, 0)

  answer = 201
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  await server.inject({ method: 'POST', url: '/api/push/subscriptions', headers: { cookie: laptop }, payload: {
    endpoint: `${origin}/push/again`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } } })
  await server.inject({ method: 'POST', url: '/api/logout', headers: { cookie: laptop } })
  assert.equal((await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1', [user.id])).rowCount, 0, 'signing out removes the device')
})

test('without VAPID keys reminders are off', async t => {
  const server = createApp(pool, null)
  t.after(() => server.close())
  const cookie = await login(server, 'alice@example.test')
  assert.deepEqual((await server.inject({ url: '/api/push', headers: { cookie } })).json(), { available: false, publicKey: null })
})
