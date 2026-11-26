import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { Learner } from './api'
import { AgentSettings } from './AgentSettings'
import { PersonalMemories } from './PersonalMemories'
import { StudyChat } from './StudyChat'

function ConversationIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H4l1.2-3.5A8 8 0 1 1 20 11.5Z" /><path d="M8 9h8M8 13h5" /></svg>
}

export function ConversationWorkspace({ learner, onUnauthorized, onSignOut, brand }: {
  learner: Learner
  onUnauthorized: () => void
  onSignOut: () => void
  brand: ReactNode
}) {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [hash, setHash] = useState(() => window.location.hash)
  const settingsPage = learner.canManageAgentSettings && hash === '#/settings'
  const [path, query] = hash.split('?', 2)
  const memoryPage = path === '#/memory'
  const page = settingsPage ? '运行设置' : memoryPage ? '个人记忆' : '学习空间'
  const previousPage = useRef(hash)
  const toggle = useRef<HTMLButtonElement>(null)
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useLayoutEffect(() => {
    if (previousPage.current !== hash) {
      main.current?.focus()
      previousPage.current = hash
    }
  }, [hash])

  function onNavigationClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    setNavigationOpen(false)
    main.current?.focus()
  }

  return (
    <div className="workspace">
      <title>{page + ' · Human Epochs'}</title>
      <aside className={`sidebar${navigationOpen ? ' is-open' : ''}`} aria-label="学习导航" onKeyDown={event => {
        if (event.key === 'Escape' && navigationOpen) {
          setNavigationOpen(false)
          toggle.current?.focus()
        }
      }}>
        <div className="sidebar-brand">
          <a href="#/" onClick={onNavigationClick} aria-label="Human Epochs 学习空间">{brand}</a>
          <button ref={toggle} className="navigation-toggle" aria-expanded={navigationOpen}
            aria-controls="workspace-navigation" onClick={() => setNavigationOpen(value => !value)}>
            {navigationOpen ? '收起学习导航' : '展开学习导航'}
          </button>
        </div>
        <div className="sidebar-content" id="workspace-navigation">
          <nav aria-label="学习空间导航">
            <a className="home-link" href="#/" aria-current={settingsPage || memoryPage ? undefined : 'page'} onClick={onNavigationClick}><ConversationIcon />学习空间</a>
            <a className="home-link" href="#/memory" aria-current={memoryPage ? 'page' : undefined} onClick={onNavigationClick}>个人记忆</a>
            {learner.canManageAgentSettings && <a className="home-link" href="#/settings" aria-current={settingsPage ? 'page' : undefined} onClick={onNavigationClick}>
              <span className="settings-nav-icon" aria-hidden="true">⚙︎</span>运行设置
            </a>}
          </nav>
          <div className="sidebar-account"><span className="avatar" aria-hidden="true">{Array.from(learner.displayName)[0]}</span><span>{learner.displayName}</span><button onClick={onSignOut}>退出</button></div>
        </div>
      </aside>
      <main ref={main} id="main" tabIndex={-1} className={settingsPage || memoryPage ? 'settings-pane' : 'conversation-pane'}
        aria-labelledby={settingsPage ? 'settings-heading' : memoryPage ? 'memory-heading' : 'workspace-heading'}>
        {settingsPage ? <AgentSettings learnerId={learner.id} onUnauthorized={onUnauthorized} />
          : memoryPage ? <PersonalMemories key={hash} learnerId={learner.id}
            sourceId={new URLSearchParams(query).get('source')} onUnauthorized={onUnauthorized} />
          : <StudyChat learnerId={learner.id} onUnauthorized={onUnauthorized} />}
      </main>
    </div>
  )
}
