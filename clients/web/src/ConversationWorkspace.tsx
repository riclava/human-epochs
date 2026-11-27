import { useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { useWorkspacePages } from './workspace-pages'

export function ConversationWorkspace({ user, onUnauthorized, onSignOut, brand }: {
  user: User
  onUnauthorized: () => void
  onSignOut: () => void
  brand: ReactNode
}) {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const { current, available, home } = useWorkspacePages(user)
  const { href, title, paneClassName, View } = current
  const heading = { id: 'workspace-heading', text: title }
  const previousPage = useRef(href)
  const toggle = useRef<HTMLButtonElement>(null)
  const main = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    if (previousPage.current !== href) {
      main.current?.focus()
      previousPage.current = href
    }
  }, [href])

  function onNavigationClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    setNavigationOpen(false)
    if (event.currentTarget.hash === href) main.current?.focus()
  }

  return (
    <div className="workspace">
      <title>{title + ' · Human Epochs'}</title>
      <aside className={`sidebar${navigationOpen ? ' is-open' : ''}`} aria-label="工作区侧栏" onKeyDown={event => {
        if (event.key === 'Escape' && navigationOpen) {
          setNavigationOpen(false)
          toggle.current?.focus()
        }
      }}>
        <div className="sidebar-brand">
          <a href={home.href} onClick={onNavigationClick} aria-label={'Human Epochs ' + home.title}>{brand}</a>
          <button ref={toggle} className="navigation-toggle" aria-expanded={navigationOpen}
            aria-controls="workspace-navigation" onClick={() => setNavigationOpen(value => !value)}>
            {navigationOpen ? '收起导航' : '展开导航'}
          </button>
        </div>
        <div className="sidebar-content" id="workspace-navigation">
          <nav aria-label="主导航">
            {available.map(page => <a key={page.href} className="workspace-link" href={page.href}
              aria-current={page === current ? 'page' : undefined} onClick={onNavigationClick}>
              {page.icon}{page.title}
            </a>)}
          </nav>
          <div className="sidebar-account"><span className="avatar" aria-hidden="true">{Array.from(user.displayName)[0]}</span><span>{user.displayName}</span><button onClick={onSignOut}>退出</button></div>
        </div>
      </aside>
      <main ref={main} id="main" tabIndex={-1} className={paneClassName} aria-labelledby={heading.id}>
        <View heading={heading} userId={user.id} onUnauthorized={onUnauthorized} />
      </main>
    </div>
  )
}
