import { useHash } from './use-hash'
import type { ComponentType, ReactNode } from 'react'
import type { User } from '../../../src/contracts/session'
import { AccountView } from './AccountView'
import { AgentSettings } from './AgentSettings'
import { ConversationView } from './ConversationView'
import { LearningGoalsView } from './LearningGoalsView'
import { TodayView } from './TodayView'
import { LearningRecordView } from './LearningRecordView'
import { MaterialLibraryView } from './MaterialLibraryView'
import { ConversationSearchView } from './ConversationSearchView'
import { conversationRoute, searchRoute } from './routes'

export { conversationHref, conversationRoute } from './routes'
export { useHash } from './use-hash'

export interface WorkspacePageProps {
  userId: string
  user: User
  // Asks for the session again after the account changed, so the sidebar shows the new name.
  onAccountChanged: () => void
  onAccountDeleted: () => void
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
  // Pages reached from elsewhere, such as the account page from the sidebar's account area.
  inNavigation?: false
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

const goals: WorkspacePage = {
  href: '#/goals',
  title: '学习目标',
  paneClassName: 'settings-pane',
  icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="0.8" fill="currentColor" />
  </svg>,
  View: LearningGoalsView,
}

const search: WorkspacePage = {
  href: '#/search',
  title: '搜索对话',
  paneClassName: 'settings-pane',
  icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" />
  </svg>,
  View: ConversationSearchView,
  matches: hash => searchRoute(hash) !== null,
}

const today: WorkspacePage = {
  href: '#/today',
  title: '今天',
  paneClassName: 'settings-pane',
  icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" />
  </svg>,
  View: TodayView,
}

const pages: readonly WorkspacePage[] = [today, conversation, search, goals, learning, materials, {
  href: '#/settings',
  title: '运行设置',
  paneClassName: 'settings-pane',
  icon: <span className="settings-nav-icon" aria-hidden="true">⚙︎</span>,
  View: AgentSettings,
  canOpen: user => user.canManageAgentSettings,
}, {
  href: '#/account',
  title: '账号设置',
  paneClassName: 'settings-pane',
  icon: null,
  View: AccountView,
  inNavigation: false,
}]

export function useWorkspacePages(user: User) {
  const hash = useHash()
  const available = pages.filter(page => page.canOpen?.(user) ?? true)
  const current = available.find(page => page.matches ? page.matches(hash) : page.href === hash) ?? conversation
  return { current, available, home: conversation, conversationId: current === conversation ? conversationRoute(hash) : null }
}
