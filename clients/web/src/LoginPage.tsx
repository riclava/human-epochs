import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { HttpError, request } from './api'
import { ForgotPasswordForm } from './AccountRecovery'
import { SignUpForm } from './SignUpForm'

const loginErrors = {
  credentials: '邮箱或密码有误。请核对后再登录。',
  format: '请检查邮箱格式和密码，再试一次。',
  unavailable: '暂时无法登录。请检查网络连接后重试。',
}

type Mode = 'sign-in' | 'sign-up' | 'forgot'
const modeTitles: Record<Mode, string> = { 'sign-in': '登录', 'sign-up': '注册', forgot: '找回密码' }

export function LoginPage({ onSuccess, notice }: { onSuccess: () => void; notice?: string }) {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [offers, setOffers] = useState({ open: false, passwordReset: false })
  // Coming back to sign-in puts focus on the button that left it.
  const returnFrom = useRef<Mode | null>(null)
  const signUpButton = useRef<HTMLButtonElement>(null)
  const forgotButton = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void request('/registration', { signal: controller.signal })
      .then(response => response.json() as Promise<{ open: boolean; passwordReset: boolean }>)
      .then(setOffers, () => {})
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (mode !== 'sign-in' || !returnFrom.current) return
    ;(returnFrom.current === 'forgot' ? forgotButton : signUpButton).current?.focus()
  }, [mode])
  const backToSignIn = () => {
    returnFrom.current = mode
    setMode('sign-in')
  }

  return (
    <main id="main" className="login-page">
      <title>{modeTitles[mode] + ' · Human Epochs'}</title>
      <LoginCover />
      <section className="login-form-panel" aria-labelledby="login-title">
        {mode === 'sign-up' ? <SignUpForm onSuccess={onSuccess} onSignIn={backToSignIn} />
          : mode === 'forgot' ? <ForgotPasswordForm onSignIn={backToSignIn} />
          : <SignInForm onSuccess={onSuccess} notice={notice} switchTo={<>
            {offers.passwordReset && <p className="login-switch">
              <button ref={forgotButton} type="button" className="link-button" onClick={() => setMode('forgot')}>忘记密码？</button></p>}
            {offers.open && <p className="login-switch">还没有账号？
              <button ref={signUpButton} type="button" className="link-button" onClick={() => setMode('sign-up')}>注册</button></p>}
          </>} />}
        {import.meta.env.DEV && mode === 'sign-in' && (
          <details className="dev-accounts">
            <summary>开发体验账号</summary>
            <p>邮箱 <code>alice@example.test</code> 或 <code>bob@example.test</code></p>
            <p>密码 <code>HumanEpochs-demo-1!</code></p>
          </details>
        )}
      </section>
    </main>
  )
}

function LoginCover() {
  return <aside className="cover" aria-label="关于 Human Epochs">
    <div className="cover-copy">
      <p>通用学习 Agent</p>
      <p className="cover-title">你想弄懂什么？</p>
      <p className="cover-description">我们希望它能陪你探索不同领域，也能从你分享的经历中理解你的选择和理由，逐步成长为数字生命。</p>
    </div>
    <div className="cover-graph" aria-hidden="true">
      <i className="rail rail-a" /><i className="rail rail-b" /><i className="rail rail-c" />
      <i className="path path-a" /><i className="path path-b" /><i className="path path-c" />
    </div>
  </aside>
}

function SignInForm({ onSuccess, notice, switchTo }: { onSuccess: () => void; notice?: string; switchTo: ReactNode }) {
  const [error, setError] = useState<keyof typeof loginErrors | null>(null)
  const [pending, setPending] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)
  const email = useRef<HTMLInputElement>(null)
  const submitButton = useRef<HTMLButtonElement>(null)
  const fieldError = error === 'credentials' || error === 'format'

  useEffect(() => {
    if (notice) title.current?.focus()
  }, [notice])

  useEffect(() => {
    if (fieldError) email.current?.focus()
    else if (error) submitButton.current?.focus()
  }, [fieldError, error])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      await request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(form.get('email')).trim(), password: form.get('password') }),
      })
      onSuccess()
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 401) setError('credentials')
      else if (cause instanceof HttpError && cause.status === 400) setError('format')
      else setError('unavailable')
      setPending(false)
    }
  }
  return (
    <form onSubmit={submit} onChange={() => setError(null)} aria-busy={pending}>
      <h1 id="login-title" ref={title} tabIndex={-1} aria-describedby={notice ? 'login-intro' : undefined}>登录</h1>
      <p className="form-intro" id="login-intro">{notice ?? '登录后，和 Agent 聊聊你想学什么。'}</p>
      <label htmlFor="email">邮箱</label>
      <input ref={email} type="email" id="email" name="email" required autoComplete="username" maxLength={254}
        placeholder="name@example.com" readOnly={pending}
        aria-invalid={fieldError || undefined} aria-describedby={fieldError ? 'login-error' : undefined} />
      <label htmlFor="password">密码</label>
      <input type="password" id="password" name="password" required autoComplete="current-password" maxLength={1024}
        readOnly={pending} aria-invalid={fieldError || undefined} aria-describedby={fieldError ? 'login-error' : undefined} />
      {error && <p id="login-error" className="form-error" role="alert">{loginErrors[error]}</p>}
      <button ref={submitButton} type="submit" className="primary" disabled={pending}>{pending ? '正在登录…' : '进入对话'}</button>
      {switchTo}
    </form>
  )
}
