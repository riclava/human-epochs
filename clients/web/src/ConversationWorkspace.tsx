import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { ConversationListPanel } from './ConversationListPanel'
import { useConversationList } from './useConversationList'
import { hasTodayContent, type TodayView } from '../../../src/contracts/today'
import { request } from './api'
import { useReminderRenewal } from './ReviewReminders'
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
  useReminderRenewal(user.id)
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

  // Opening the workspace without an address goes to Today when something is waiting there, and otherwise to the most
  // recent conversation, or a new one when there is none. Only the first visit is diverted: choosing "对话" later opens
  // a conversation.
  // Entering through any other address already counts as having entered.
  const enteredWorkspace = useRef(!['', '#/'].includes(window.location.hash))
  useEffect(() => {
    if (current !== home || conversationId || !conversations.loaded) return
    const open = (hash: string) => {
      enteredWorkspace.current = true
      window.location.replace(hash)
    }
    const latest = () => open(conversationHref(conversations.items[0]?.conversationId ?? crypto.randomUUID()))
    if (enteredWorkspace.current) return latest()
    // Marked only once the answer arrives, so a cancelled check does not skip Today.
    const controller = new AbortController()
    request('/today', { headers: { 'X-User-Id': user.id }, signal: controller.signal })
      .then(response => response.json() as Promise<TodayView>)
      .then(view => {
        if (controller.signal.aborted) return
        if (hasTodayContent(view)) open('#/today')
        else latest()
      }, () => { if (!controller.signal.aborted) latest() })
    return () => controller.abort()
  }, [current, home, conversationId, conversations.loaded, conversations.items, user.id])

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
          {user.emailVerified === false && <a className="sidebar-notice" href="#/account" onClick={onNavigationClick}>邮箱还没有确认</a>}
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
