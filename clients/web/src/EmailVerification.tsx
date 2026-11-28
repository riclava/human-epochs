import { useState } from 'react'
import type { User } from '../../../src/contracts/session'
import { HttpError, request } from './api'

// Shows whether the sign-in address is confirmed and sends the confirmation mail again. Nothing shows when the
// server sends no mail.
export function EmailVerification({ user, onUnauthorized, onVerified }: { user: User; onUnauthorized: () => void; onVerified: () => void }) {
  const [state, setState] = useState<{ kind: 'idle' | 'pending' } | { kind: 'sent' | 'error'; text: string }>({ kind: 'idle' })
  if (user.emailVerified === null) return null
  if (user.emailVerified) return <p className="email-state">邮箱已确认，忘记密码时可以通过它找回。</p>

  async function resend() {
    setState({ kind: 'pending' })
    try {
      const response = await request('/email-verification', { method: 'POST', headers: { 'X-User-Id': user.id } })
      if (response.status === 200) return onVerified()
      setState({ kind: 'sent', text: `确认邮件已发到 ${user.email}，链接 24 小时内有效。` })
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return onUnauthorized()
      const status = error instanceof HttpError ? error.status : 0
      setState({ kind: 'error', text: status === 429 ? '发送太频繁。请一小时后再试。' : '邮件没有发出去。请稍后重试。' })
    }
  }

  return <div className="email-state">
    <p>邮箱还没有确认。确认后，忘记密码时可以通过它找回。</p>
    <button type="button" onClick={() => void resend()} disabled={state.kind === 'pending'}>
      {state.kind === 'pending' ? '正在发送…' : '重新发送确认邮件'}</button>
    <p role={state.kind === 'error' ? 'alert' : 'status'} className={state.kind === 'error' ? 'form-error' : 'form-done'}>
      {state.kind === 'sent' || state.kind === 'error' ? state.text : ''}</p>
  </div>
}
