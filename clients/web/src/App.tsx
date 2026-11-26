import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ConversationWorkspace } from './ConversationWorkspace'
import { HttpError, request } from './api'
import type { Learner } from './api'

type SessionState =
  | { state: 'checking' | 'signing-out' | 'check-error' | 'sign-out-error' }
  | { state: 'anonymous'; notice?: string }
  | { state: 'authenticated'; learner: Learner }

const authenticationChannel = 'human-epochs-authentication'
const sessionTitles = {
  checking: '确认登录状态',
  anonymous: '登录',
  'signing-out': '正在退出',
  'check-error': '无法确认登录状态',
  'sign-out-error': '退出未完成',
}

function focusMain() {
  const main = document.getElementById('main')
  main?.setAttribute('tabindex', '-1')
  main?.focus()
}

function Brand() {
  return <span className="brand"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>Human Epochs</span>
}

const loginErrors = {
  credentials: '邮箱或密码有误。请核对后再登录。',
  format: '请检查邮箱格式和密码，再试一次。',
  unavailable: '暂时无法登录。请检查网络连接后重试。',
}

function Login({ onSuccess, notice }: { onSuccess: () => void; notice?: string }) {
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
    <main id="main" className="login-page">
      <aside className="cover" aria-label="关于 Human Epochs">
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
      <section className="login-form-panel" aria-labelledby="login-title">
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
          <button ref={submitButton} type="submit" className="primary" disabled={pending}>{pending ? '正在登录…' : '进入学习空间'}</button>
        </form>
        {import.meta.env.DEV && (
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

export function App() {
  const [session, setSession] = useState<SessionState>({ state: 'checking' })
  const activeCheck = useRef<AbortController | null>(null)
  const authenticationEvents = useRef<BroadcastChannel | null>(null)
  const signingOut = useRef(false)
  const wasAuthenticated = useRef(false)
  const focusAfterLogin = useRef(false)
  const retryButton = useRef<HTMLButtonElement>(null)

  const checkSession = useCallback(async () => {
    if (signingOut.current) return
    activeCheck.current?.abort()
    const controller = new AbortController()
    activeCheck.current = controller
    setSession({ state: 'checking' })
    try {
      const response = await request('/session', { signal: controller.signal })
      const { learner }: { learner: Learner } = await response.json()
      if (controller.signal.aborted) return
      wasAuthenticated.current = true
      setSession({ state: 'authenticated', learner })
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && error.status === 401) {
        let notice: string | undefined
        if (wasAuthenticated.current) notice = '登录状态已结束。请重新登录以返回学习空间。'
        else if (focusAfterLogin.current) notice = '登录状态未能保存。请确认浏览器允许本站使用 Cookie，再重新登录。'
        wasAuthenticated.current = false
        focusAfterLogin.current = false
        setSession({ state: 'anonymous', notice })
      } else {
        setSession({ state: 'check-error' })
      }
    }
  }, [])

  useEffect(() => {
    void checkSession()
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) void checkSession() }
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(authenticationChannel) : null
    authenticationEvents.current = channel
    if (channel) channel.onmessage = event => {
      if (event.data === 'changed') void checkSession()
    }
    window.addEventListener('pageshow', onPageShow)
    return () => {
      activeCheck.current?.abort()
      window.removeEventListener('pageshow', onPageShow)
      authenticationEvents.current = null
      channel?.close()
    }
  }, [checkSession])

  useEffect(() => {
    if (session.state !== 'authenticated') return
    function onVisible() {
      if (document.visibilityState === 'visible') void checkSession()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [session.state, checkSession])

  useEffect(() => {
    if (session.state === 'authenticated' && focusAfterLogin.current) {
      focusAfterLogin.current = false
      focusMain()
    }
    if (session.state === 'check-error' || session.state === 'sign-out-error') retryButton.current?.focus()
  }, [session.state])

  async function signOut() {
    if (signingOut.current) return
    signingOut.current = true
    activeCheck.current?.abort()
    setSession({ state: 'signing-out' })
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
    try {
      await request('/logout', { method: 'POST' })
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 401)) {
        setSession({ state: 'sign-out-error' })
        return
      }
    } finally {
      signingOut.current = false
    }
    wasAuthenticated.current = false
    authenticationEvents.current?.postMessage('changed')
    setSession({ state: 'anonymous', notice: '已退出学习空间。你可以重新登录或使用其他账号。' })
  }

  return (
    <>
      {session.state !== 'authenticated' && <title>{sessionTitles[session.state] + ' · Human Epochs'}</title>}
      <a className="skip-link" href="#main" onClick={event => {
        event.preventDefault()
        focusMain()
      }}>跳到主要内容</a>
      {session.state !== 'authenticated' && <header className="site-header">
        <div className="shell topbar">
          <Brand />
        </div>
      </header>}
      <div className={session.state === 'authenticated' ? undefined : 'shell'}>
        {session.state === 'checking' && <main id="main" className="page"><div role="status"><h1>正在确认登录状态…</h1></div></main>}
        {session.state === 'signing-out' && <main id="main" className="page"><div role="status"><h1>正在退出…</h1></div></main>}
        {session.state === 'check-error' && (
          <main id="main" className="page notice notice-error">
            <h1>无法确认登录状态</h1>
            <p role="alert">请检查网络连接，再重新检查登录状态。</p>
            <button ref={retryButton} onClick={() => void checkSession()}>重新检查登录状态</button>
          </main>
        )}
        {session.state === 'sign-out-error' && (
          <main id="main" className="page notice notice-error">
            <h1>退出未完成</h1>
            <p role="alert">请检查网络连接后再次退出。</p>
            <button ref={retryButton} onClick={signOut}>重新退出</button>
          </main>
        )}
        {session.state === 'anonymous' && <Login notice={session.notice} onSuccess={() => {
          authenticationEvents.current?.postMessage('changed')
          focusAfterLogin.current = true
          void checkSession()
        }} />}
        {session.state === 'authenticated' && <ConversationWorkspace
          key={session.learner.id}
          learner={session.learner}
          onUnauthorized={checkSession}
          onSignOut={signOut}
          brand={<Brand />}
        />}
      </div>
    </>
  )
}
