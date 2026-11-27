import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { ConversationListPanel } from './ConversationListPanel'
import { useConversationList } from './useConversationList'
import { conversationHref, useWorkspacePages } from './workspace-pages'

export function ConversationWorkspace({ user, onUnauthorized, onAccountChanged, onAccountDeleted, onSignOut, brand }: {
  user: User
  onUnauthorized: () => void
  onAccountChanged: () => void
  onAccountDeleted: () => void
  onSignOut: () => void
  brand: ReactNode
}) {
  const [navigationOpen, setNavigationOpen] = useState(false)
  const { current, available, home, conversationId } = useWorkspacePages(user)
  const conversations = useConversationList(user.id, onUnauthorized)
  const { href, title, paneClassName, View } = current
  const heading = { id: 'workspace-heading', text: title }
  const location = conversationId ?? href
  const previousLocation = useRef(location)
  const toggle = useRef<HTMLButtonElement>(null)
  const main = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    // Opening the chosen conversation from "#/" is not a navigation of its own, so focus stays where it was.
    if (previousLocation.current !== location && previousLocation.current !== home.href) main.current?.focus()
    previousLocation.current = location
  }, [location, home.href])

  // The conversation page without an ID opens the most recent conversation, or a new one when there is none.
  useEffect(() => {
    if (current !== home || conversationId || !conversations.loaded) return
    window.location.replace(conversationHref(conversations.items[0]?.conversationId ?? crypto.randomUUID()))
  }, [current, home, conversationId, conversations.loaded, conversations.items])

  function onNavigationClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    setNavigationOpen(false)
    if (event.currentTarget.hash === window.location.hash) main.current?.focus()
  }

  function startConversation() {
    setNavigationOpen(false)
    window.location.hash = conversationHref(crypto.randomUUID())
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
            {available.filter(page => page.inNavigation ?? true).map(page => <a key={page.href} className="workspace-link" href={page.href}
              aria-current={page === current ? 'page' : undefined} onClick={onNavigationClick}>
              {page.icon}{page.title}
            </a>)}
          </nav>
          <ConversationListPanel userId={user.id} items={conversations.items} loaded={conversations.loaded} error={conversations.error}
            currentId={conversationId} onReplace={conversations.replace} onRefresh={conversations.refresh}
            onNavigate={onNavigationClick} onStart={startConversation} onUnauthorized={onUnauthorized} />
          <div className="sidebar-account"><span className="avatar" aria-hidden="true">{Array.from(user.displayName)[0]}</span><a href="#/account" className="account-link" onClick={onNavigationClick}
            aria-current={href === '#/account' ? 'page' : undefined} aria-label={`账号设置：${user.displayName}`}>{user.displayName}</a>
            <button onClick={onSignOut}>退出</button></div>
        </div>
      </aside>
      <main ref={main} id="main" tabIndex={-1} className={paneClassName} aria-labelledby={heading.id}>
        <View key={conversationId ?? href} heading={heading} userId={user.id} user={user} onUnauthorized={onUnauthorized}
          onAccountChanged={onAccountChanged} onAccountDeleted={onAccountDeleted}
          conversationId={conversationId} onConversationsChanged={conversations.refresh}
          conversationTitle={conversations.items.find(item => item.conversationId === conversationId)?.title} />
      </main>
    </div>
  )
}
