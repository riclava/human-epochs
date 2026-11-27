import { useSyncExternalStore } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { AgentSettings } from './AgentSettings'
import { ConversationView } from './ConversationView'
import { LearningRecordView } from './LearningRecordView'
import { MaterialLibraryView } from './MaterialLibraryView'
import { conversationRoute } from './routes'

export { conversationHref, conversationRoute } from './routes'

export interface WorkspacePageProps {
  userId: string
  onUnauthorized: () => void
  heading: { id: string; text: string }
  // The conversation in the address, or null while the workspace is choosing one.
  conversationId: string | null
  onConversationsChanged: () => void
  // The title from the conversation list, which updates first after a rename.
  conversationTitle?: string
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

const learning: WorkspacePage = {
  href: '#/learning',
  title: '学习记录',
  paneClassName: 'settings-pane',
  icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z" /><path d="M5 17a3 3 0 0 1 3-3h11M9 8h6" />
  </svg>,
  View: LearningRecordView,
}

const materials: WorkspacePage = {
  href: '#/materials',
  title: '我的材料',
  paneClassName: 'settings-pane',
  icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" />
  </svg>,
  View: MaterialLibraryView,
}

const pages: readonly WorkspacePage[] = [conversation, learning, materials, {
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
