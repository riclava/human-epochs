import { useEffect, useState } from 'react'
import { HttpError, request } from './api'

// Which user turned reminders on in this browser. Only that user's sign-in renews the device's subscription, so a
// different person signing in on the same browser does not inherit notifications they never asked for.
const ownerKey = 'human-epochs:push-user'
const readOwner = () => { try { return localStorage.getItem(ownerKey) } catch { return null } }
const writeOwner = (userId: string | null) => {
  try {
    if (userId) localStorage.setItem(ownerKey, userId)
    else localStorage.removeItem(ownerKey)
  } catch { /* The subscription still works for this session. */ }
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
const keyBytes = (key: string) => Uint8Array.from(atob(key.replace(/-/gu, '+').replace(/_/gu, '/')), character => character.charCodeAt(0))

async function readServer(userId: string) {
  const response = await request('/push', { headers: { 'X-User-Id': userId } })
  return await response.json() as { available: boolean; publicKey: string | null }
}

const save = (userId: string, subscription: PushSubscription) => request('/push/subscriptions', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId }, body: JSON.stringify(subscription.toJSON()),
})

// Signing out removes the device on the server; signing in again as the same user puts it back.
export function useReminderRenewal(userId: string) {
  useEffect(() => {
    if (!supported() || Notification.permission !== 'granted' || readOwner() !== userId) return
    void navigator.serviceWorker.ready
      .then(registration => registration.pushManager.getSubscription())
      .then(subscription => subscription && save(userId, subscription))
      .catch(() => {})
  }, [userId])
}

type State = 'loading' | 'off-server' | 'unsupported' | 'denied' | 'off' | 'on' | 'busy'

export function ReviewReminders({ userId, onUnauthorized }: { userId: string; onUnauthorized: () => void }) {
  const [state, setState] = useState<State>('loading')
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let active = true
    void (async () => {
      const server = await readServer(userId).catch(() => null)
      if (!active) return
      if (!server?.available || !server.publicKey) return setState('off-server')
      setPublicKey(server.publicKey)
      if (!supported()) return setState('unsupported')
      if (Notification.permission === 'denied') return setState('denied')
      const subscription = await navigator.serviceWorker.ready.then(registration => registration.pushManager.getSubscription()).catch(() => null)
      if (active) setState(subscription && readOwner() === userId ? 'on' : 'off')
    })()
    return () => { active = false }
  }, [userId])

  async function turnOn() {
    setState('busy')
    setFailure('')
    try {
      if (await Notification.requestPermission() !== 'granted') return setState('denied')
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey!) })
      await save(userId, subscription)
      writeOwner(userId)
      setState('on')
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return onUnauthorized()
      setFailure('没能开启提醒。请稍后重试。')
      setState('off')
    }
  }

  async function turnOff() {
    setState('busy')
    setFailure('')
    try {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription()
      if (subscription) {
        await request('/push/subscriptions/remove', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
          body: JSON.stringify({ endpoint: subscription.endpoint }) })
        await subscription.unsubscribe()
      }
      writeOwner(null)
      setState('off')
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return onUnauthorized()
      setFailure('没能关闭提醒。请稍后重试。')
      setState('on')
    }
  }

  if (state === 'loading' || state === 'off-server') return null
  return <section className="settings-section" aria-labelledby="account-reminders-title">
    <div className="settings-section-heading"><h2 id="account-reminders-title">复习提醒</h2>
      <p>复习到期时，在这台设备上发一条通知。每台设备分别开启。</p></div>
    <div className="reminder-state">
      {state === 'unsupported' && <p>这个浏览器不支持通知。在 iPhone 或 iPad 上，先用 Safari 把 Human Epochs 添加到主屏幕，再从主屏幕打开后开启。</p>}
      {state === 'denied' && <p>通知已被浏览器阻止。请在浏览器的网站设置里允许 Human Epochs 发送通知，再回到这里开启。</p>}
      {(state === 'off' || state === 'on' || state === 'busy') && <>
        <p role="status">{state === 'on' ? '这台设备会在复习到期时收到通知。' : state === 'off' ? '这台设备还没有开启复习提醒。' : '正在设置…'}</p>
        {state === 'on'
          ? <button type="button" onClick={() => void turnOff()}>在这台设备上关闭</button>
          : <button type="button" disabled={state === 'busy'} onClick={() => void turnOn()}>在这台设备上开启</button>}
      </>}
      {failure && <p role="alert" className="form-error">{failure}</p>}
    </div>
  </section>
}
