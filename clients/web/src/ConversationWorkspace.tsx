import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { useConversationList } from './useConversationList'
import { conversationHref, useWorkspacePages } from './workspace-pages'

export function ConversationWorkspace({ user, onUnauthorized, onSignOut, brand }: {
  user: User
  onUnauthorized: () => void
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
            {available.map(page => <a key={page.href} className="workspace-link" href={page.href}
              aria-current={page === current ? 'page' : undefined} onClick={onNavigationClick}>
              {page.icon}{page.title}
            </a>)}
          </nav>
          <section className="conversation-list" aria-labelledby="conversation-list-heading">
            <div className="conversation-list-header">
              <h2 id="conversation-list-heading">最近的对话</h2>
              <button type="button" className="new-conversation" onClick={startConversation}>新对话</button>
            </div>
            {conversations.error && <div className="conversation-list-error">
              <p role="alert">暂时无法读取对话列表。</p>
              <button type="button" onClick={conversations.refresh}>重新读取</button>
            </div>}
            {conversations.loaded && !conversations.error && !conversations.items.length &&
              <p className="conversation-list-empty">发出第一条消息后，对话会出现在这里。</p>}
            {conversations.items.length > 0 && <ul>
              {conversations.items.map(item => <li key={item.conversationId}>
                <a href={conversationHref(item.conversationId)} onClick={onNavigationClick}
                  aria-current={item.conversationId === conversationId ? 'page' : undefined}>{item.title}</a>
              </li>)}
            </ul>}
          </section>
          <div className="sidebar-account"><span className="avatar" aria-hidden="true">{Array.from(user.displayName)[0]}</span><span>{user.displayName}</span><button onClick={onSignOut}>退出</button></div>
        </div>
      </aside>
      <main ref={main} id="main" tabIndex={-1} className={paneClassName} aria-labelledby={heading.id}>
        <View key={conversationId ?? href} heading={heading} userId={user.id} onUnauthorized={onUnauthorized}
          conversationId={conversationId} onConversationsChanged={conversations.refresh} />
      </main>
    </div>
  )
}
