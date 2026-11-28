import type { ConversationListItem } from './conversation.js'
import type { LearningGoalActivity } from './learning-goal.js'

export interface TodayReview {
  reviewInvitationId: string
  topic: string
  sourceLabel: string
  // The conversation the reviewed discussion happened in, where answering continues.
  conversationId: string
  conversationTitle: string
}

export interface TodayGoal {
  id: string
  title: string
  progress: string
  dueReviews: number
  latestResult: LearningGoalActivity['latestResult']
  // The goal's most recently used conversation, or null when none belongs to it yet.
  conversationId: string | null
}

// Something an earlier reply offered that the user has not decided on yet.
export interface TodayPending {
  kind: 'goal_proposal' | 'goal_progress' | 'memory_candidate'
  conversationId: string
  requestId: string
  // What the item is about: a goal title, new progress, or a memory to keep.
  text: string
}

export interface TodayView {
  review: TodayReview | null
  goals: TodayGoal[]
  pending: TodayPending[]
  recentConversations: ConversationListItem[]
}

export const hasTodayContent = (view: TodayView) => !!view.review || view.goals.length > 0 || view.pending.length > 0
