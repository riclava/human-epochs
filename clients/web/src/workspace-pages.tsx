import { useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { AgentSettings } from './AgentSettings'
import { ConversationView } from './ConversationView'

export interface WorkspacePageProps {
  userId: string
  onUnauthorized: () => void
  heading: { id: string; text: string }
  // The conversation in the address, or null while the workspace is choosing one.
  conversationId: string | null
  onConversationsChanged: () => void
}

interface WorkspacePage {
  href: `#/${string}`
  title: string
  paneClassName: string
  icon: ReactNode
  View: ComponentType<WorkspacePageProps>
  canOpen?: (user: User) => boolean
  matches?: (hash: string) => boolean
}

const conversationPath = /^#\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u

export const conversationHref = (conversationId: string) => `#/c/${conversationId}` as const

export function conversationRoute(hash: string) {
  return conversationPath.exec(hash.toLowerCase())?.[1] ?? null
}

const conversation: WorkspacePage = {
  href: '#/',
  title: '对话',
  paneClassName: 'conversation-pane',
  icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M20 11.5a8 8 0 0 1-8 8H4l1.2-3.5A8 8 0 1 1 20 11.5Z" /><path d="M8 9h8M8 13h5" />
  </svg>,
  View: ConversationView,
  matches: hash => hash === '' || hash === '#/' || conversationRoute(hash) !== null,
}

const pages: readonly WorkspacePage[] = [conversation, {
  href: '#/settings',
  title: '运行设置',
  paneClassName: 'settings-pane',
  icon: <span className="settings-nav-icon" aria-hidden="true">⚙︎</span>,
  View: AgentSettings,
  canOpen: user => user.canManageAgentSettings,
}]

function subscribeToHash(notify: () => void) {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}

function readHash() {
  return window.location.hash
}

export function useWorkspacePages(user: User) {
  const hash = useSyncExternalStore(subscribeToHash, readHash)
  const available = pages.filter(page => page.canOpen?.(user) ?? true)
  const current = available.find(page => page.matches ? page.matches(hash) : page.href === hash) ?? conversation
  return { current, available, home: conversation, conversationId: current === conversation ? conversationRoute(hash) : null }
}
