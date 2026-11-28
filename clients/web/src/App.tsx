import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '../../../src/contracts/session'
import { ConversationWorkspace } from './ConversationWorkspace'
import { HttpError, request } from './api'
import { LoginPage } from './LoginPage'
import { RecoveryPage } from './AccountRecovery'
import { recoveryRoute } from './routes'
import { useHash } from './use-hash'

type SessionState =
  | { state: 'checking' | 'signing-out' | 'check-error' | 'sign-out-error' }
  | { state: 'anonymous'; notice?: string }
  | { state: 'authenticated'; user: User }

type SessionCheck = 'required' | 'background'

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

export function App() {
  const [session, setSession] = useState<SessionState>({ state: 'checking' })
  const activeCheck = useRef<AbortController | null>(null)
  const authenticationEvents = useRef<BroadcastChannel | null>(null)
  const signingOut = useRef(false)
  const wasAuthenticated = useRef(false)
  const focusAfterLogin = useRef(false)
  const retryButton = useRef<HTMLButtonElement>(null)

  const checkSession = useCallback(async (kind: SessionCheck = 'required') => {
    if (signingOut.current || (kind === 'background' && activeCheck.current)) return
    activeCheck.current?.abort()
    const controller = new AbortController()
    activeCheck.current = controller
    if (kind === 'required') setSession({ state: 'checking' })
    try {
      const response = await request('/session', { signal: controller.signal })
      const { user }: { user: User } = await response.json()
      if (controller.signal.aborted) return
      wasAuthenticated.current = true
      setSession({ state: 'authenticated', user })
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && error.status === 401) {
        let notice: string | undefined
        if (wasAuthenticated.current) notice = '登录状态已结束。请重新登录以返回对话。'
        else if (focusAfterLogin.current) notice = '登录状态未能保存。请确认浏览器允许本站使用 Cookie，再重新登录。'
        wasAuthenticated.current = false
        focusAfterLogin.current = false
        setSession({ state: 'anonymous', notice })
      } else if (kind === 'required') {
        setSession({ state: 'check-error' })
      }
    } finally {
      if (activeCheck.current === controller) activeCheck.current = null
    }
  }, [])

  const recheckSession = useCallback(() => { void checkSession() }, [checkSession])
  // A link from a verification or password reset mail, which is handled before anything else.
  const recovery = recoveryRoute(useHash())
  const finishRecovery = () => {
    window.location.replace('#/')
    authenticationEvents.current?.postMessage('changed')
    focusAfterLogin.current = true
    void checkSession()
  }

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
      if (document.visibilityState === 'visible') void checkSession('background')
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
    setSession({ state: 'anonymous', notice: '已退出登录。你可以重新登录或使用其他账号。' })
  }

  return (
    <>
      {!recovery && session.state !== 'authenticated' && session.state !== 'anonymous' && <title>{sessionTitles[session.state] + ' · Human Epochs'}</title>}
      <a className="skip-link" href="#main" onClick={event => {
        event.preventDefault()
        focusMain()
      }}>跳到主要内容</a>
      {(recovery || session.state !== 'authenticated') && <header className="site-header">
        <div className="shell topbar">
          <Brand />
        </div>
      </header>}
      {recovery ? <div className="shell"><RecoveryPage route={recovery} onDone={finishRecovery} /></div> : <div className={session.state === 'authenticated' ? undefined : 'shell'}>
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
        {session.state === 'anonymous' && <LoginPage notice={session.notice} onSuccess={() => {
          authenticationEvents.current?.postMessage('changed')
          focusAfterLogin.current = true
          void checkSession()
        }} />}
        {session.state === 'authenticated' && <ConversationWorkspace
          key={session.user.id}
          user={session.user}
          onUnauthorized={recheckSession}
          onAccountChanged={() => {
            authenticationEvents.current?.postMessage('changed')
            void checkSession('background')
          }}
          onAccountDeleted={() => {
            wasAuthenticated.current = false
            authenticationEvents.current?.postMessage('changed')
            window.history.replaceState(null, '', window.location.pathname + window.location.search)
            setSession({ state: 'anonymous', notice: '账号已删除。感谢你使用 Human Epochs。' })
          }}
          onSignOut={signOut}
          brand={<Brand />}
        />}
      </div>}
    </>
  )
}
