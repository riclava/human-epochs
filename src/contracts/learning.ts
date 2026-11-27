import { z } from 'zod'

export type ReviewResult = 'recalled' | 'partial' | 'forgotten'

export interface ReviewAttemptView {
  answeredAt: string
  result: ReviewResult
  note: string
}

// One reviewed discussion: what it is about, every answer so far, and when it comes back.
export interface LearningTopic {
  originRequestId: string
  topic: string
  sourceLabel: string
  conversationId: string
  conversationTitle: string | null
  attempts: ReviewAttemptView[]
  nextReviewAt: string | null
  stopped: boolean
}

export interface LearningRecord {
  remindersEnabled: boolean
  topics: LearningTopic[]
}

export const learningCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('stop_topic'), originRequestId: z.uuid().toLowerCase() }),
  z.strictObject({ operation: z.literal('resume_reminders') }),
])
export type LearningCommand = z.infer<typeof learningCommandSchema>
