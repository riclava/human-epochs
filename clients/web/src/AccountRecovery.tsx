import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { passwordMinLength } from '../../../src/contracts/session'
import { HttpError, request } from './api'
import type { RecoveryRoute } from './routes'

const post = (path: string, body: unknown) =>
  request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export function ForgotPasswordForm({ onSignIn }: { onSignIn: () => void }) {
  const [state, setState] = useState<{ kind: 'idle' | 'pending' } | { kind: 'sent'; email: string } | { kind: 'error'; text: string }>({ kind: 'idle' })
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => { title.current?.focus() }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim()
    setState({ kind: 'pending' })
    try {
      await post('/password-reset', { email })
      setState({ kind: 'sent', email })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 0
      setState({ kind: 'error', text: status === 400 ? '请输入有效的邮箱。' : status === 429 ? '申请太频繁。请一小时后再试。'
        : status === 503 ? '暂不支持找回密码。请联系部署方。' : '暂时无法发送。请检查网络连接后重试。' })
    }
  }

  return <form onSubmit={submit} aria-busy={state.kind === 'pending'}>
    <h1 id="login-title" ref={title} tabIndex={-1}>找回密码</h1>
    <p className="form-intro">输入注册时用的邮箱，我们会发一封带有重置链接的邮件，链接 1 小时内有效。</p>
    <label htmlFor="forgot-email">邮箱</label>
    <input type="email" id="forgot-email" name="email" required autoComplete="username" maxLength={254} placeholder="name@example.com"
      readOnly={state.kind === 'pending'} aria-invalid={state.kind === 'error' || undefined} aria-describedby={state.kind === 'error' ? 'forgot-error' : undefined} />
    {state.kind === 'error' && <p id="forgot-error" className="form-error" role="alert">{state.text}</p>}
    <p role="status" className="form-done">{state.kind === 'sent' ? `如果 ${state.email} 已注册，重置邮件马上就到。没收到的话，请检查垃圾邮件，或稍后再申请。` : ''}</p>
    <button type="submit" className="primary" disabled={state.kind === 'pending'}>{state.kind === 'pending' ? '正在发送…' : '发送重置邮件'}</button>
    <p className="login-switch"><button type="button" className="link-button" onClick={onSignIn}>返回登录</button></p>
  </form>
}

function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<'idle' | 'pending' | 'invalid' | 'short' | 'error'>('idle')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setState('pending')
    try {
      await post('/password-reset/confirm', { token, password: new FormData(event.currentTarget).get('password') })
      onDone()
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 0
      setState(status === 410 ? 'invalid' : status === 400 ? 'short' : 'error')
    }
  }
  if (state === 'invalid') return <RecoveryMessage title="链接已失效" onDone={onDone} action="返回登录">
    这个重置链接已经用过或已过期。请回到登录页，点「忘记密码？」重新申请。</RecoveryMessage>
  const problem = state === 'short' ? `新密码至少 ${passwordMinLength} 位。` : state === 'error' ? '暂时无法保存。请检查网络连接后重试。' : ''
  return <form onSubmit={submit} aria-busy={state === 'pending'}>
    <h1 id="recovery-title" tabIndex={-1}>设置新密码</h1>
    <p className="form-intro">设置后，其他设备上的登录会退出，这台设备会直接登录。</p>
    <label htmlFor="reset-password">新密码</label>
    <input type="password" id="reset-password" name="password" required minLength={passwordMinLength} maxLength={1024} autoComplete="new-password"
      autoFocus readOnly={state === 'pending'} aria-invalid={!!problem || undefined} aria-describedby={['reset-hint', problem && 'reset-error'].filter(Boolean).join(' ')} />
    <p id="reset-hint" className="field-hint">至少 {passwordMinLength} 位。</p>
    {problem && <p id="reset-error" className="form-error" role="alert">{problem}</p>}
    <button type="submit" className="primary" disabled={state === 'pending'}>{state === 'pending' ? '正在保存…' : '保存新密码'}</button>
  </form>
}

// A verification token works once, so the request is shared if the page runs its effect twice.
const verifications = new Map<string, Promise<boolean>>()
const verify = (token: string) => {
  let result = verifications.get(token)
  if (!result) verifications.set(token, result = post('/email-verification/confirm', { token }).then(() => true, () => false))
  return result
}

function VerifyEmail({ token, onDone }: { token: string; onDone: () => void }) {
  const [verified, setVerified] = useState<boolean | null>(null)
  useEffect(() => { void verify(token).then(setVerified) }, [token])
  if (verified === null) return <div role="status"><h1 id="recovery-title">正在确认邮箱…</h1></div>
  return verified
    ? <RecoveryMessage title="邮箱已确认" onDone={onDone} action="开始使用">以后忘记密码时，可以通过这个邮箱找回。</RecoveryMessage>
    : <RecoveryMessage title="链接已失效" onDone={onDone} action="返回">这个确认链接已经用过或已过期。登录后可以在「账号设置」里重新发送。</RecoveryMessage>
}

function RecoveryMessage({ title, children, action, onDone }: { title: string; children: string; action: string; onDone: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  return <div>
    <h1 id="recovery-title" ref={heading} tabIndex={-1}>{title}</h1>
    <p className="form-intro">{children}</p>
    <button type="button" className="primary" onClick={onDone}>{action}</button>
  </div>
}

export function RecoveryPage({ route, onDone }: { route: RecoveryRoute; onDone: () => void }) {
  return <main id="main" className="page recovery-page">
    <title>{(route.kind === 'reset-password' ? '设置新密码' : '确认邮箱') + ' · Human Epochs'}</title>
    <section className="login-form-panel" aria-labelledby="recovery-title">
      {route.kind === 'reset-password' ? <ResetPassword token={route.token} onDone={onDone} /> : <VerifyEmail token={route.token} onDone={onDone} />}
    </section>
  </main>
}
