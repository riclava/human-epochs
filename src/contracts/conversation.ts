import { z } from 'zod'
import type { PersonalMemorySnapshot } from './personal-memory.js'

export const conversationTextLimit = 4000

export type ConversationMode = 'guided' | 'model'

export interface ConversationSource {
  id: string
  label: string
  text: string
}

export interface ConversationMaterialOption {
  discussionVersion: string
  title: string
  question: string
  sources: ConversationSource[]
  supplements: ConversationSource[]
}

const clean = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value))
const requestId = z.uuid().toLowerCase()
export const conversationMaterialSelectionSchema = z.strictObject({
  discussionVersion: clean(160).optional(),
  parentRequestId: requestId.optional(),
  sourceIds: z.array(clean(160)).max(16).optional(),
  excerpt: z.strictObject({ label: clean(120), text: clean(conversationTextLimit) }).optional(),
})
export type ConversationMaterialSelection = z.infer<typeof conversationMaterialSelectionSchema>

export const sendConversationCommandSchema = z.strictObject({
  requestId,
  messageText: clean(conversationTextLimit),
  materialSelection: conversationMaterialSelectionSchema.optional(),
  reviewInvitationId: requestId.optional(),
}).refine(message => !(message.reviewInvitationId && message.materialSelection))
export type SendConversationCommand = z.infer<typeof sendConversationCommandSchema>

export interface ConversationMaterialContext {
  discussionVersion: string | null
  discussionId: string
  sources: ConversationSource[]
}

const citationSchema = z.strictObject({ sourceId: z.string().min(1), label: z.string(), quote: z.string().min(1) })
const textBlock = z.strictObject({
  kind: z.literal('text'), text: z.string().min(1), citations: z.array(citationSchema).optional(),
})
const excerptBlock = z.strictObject({ kind: z.literal('excerpt'), source: citationSchema })
const candidateSchema = z.discriminatedUnion('kind', [textBlock, excerptBlock])
export const conversationContentSchema = z.array(z.discriminatedUnion('kind', [
  textBlock.extend({ id: z.uuid() }),
  excerptBlock.extend({ id: z.uuid() }),
  z.strictObject({ kind: z.literal('unavailable'), id: z.uuid() }),
])).min(1).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length)

export type ConversationCitation = z.infer<typeof citationSchema>
export type ConversationContentDraft = z.infer<typeof candidateSchema>
export type ConversationContent = z.infer<typeof conversationContentSchema>

export function conversationContentText(content: readonly ConversationContentDraft[] | ConversationContent | null): string | null {
  if (!content) return null
  return content.flatMap(block => block.kind === 'text' ? [block.text] :
    block.kind === 'excerpt' ? [block.source.quote] : []).join('\n\n') || null
}

export interface UserConversationTurn {
  kind: 'user'
  requestId: string
  messageText: string
  replyBlocks: ConversationContent | null
  status: 'pending' | 'retryable' | 'failed' | 'stopped' | 'complete'
  materialContext?: ConversationMaterialContext
  explanationSource?: 'model' | 'course' | 'excerpt'
}

export interface ReviewQuestionTurn {
  kind: 'review_question'
  requestId: string
  status: 'complete'
  questionBlocks: ConversationContent
  reviewInvitationId?: string
}

export type ConversationTurn = UserConversationTurn | ReviewQuestionTurn

export interface ReviewInvitation {
  reviewInvitationId: string
  topic: string
  sourceLabel: string
}

export const reviewInvitationCommandSchema = z.strictObject({
  commandId: z.uuid().toLowerCase(), reviewInvitationId: z.uuid().toLowerCase(),
  action: z.enum(['accept', 'later', 'stop']),
})
export type ReviewInvitationCommand = z.infer<typeof reviewInvitationCommandSchema>

export interface ConversationSnapshot extends PersonalMemorySnapshot {
  mode: ConversationMode
  turns: ConversationTurn[]
  reviewInvitation?: ReviewInvitation
  starter?: Pick<ConversationMaterialOption, 'discussionVersion' | 'title' | 'question'>
}

export type ConversationProgress = 'reading_sources' | 'checking_citations'

export type ConversationStreamEvent =
  | { kind: 'received'; requestId: string }
  | { kind: 'delta'; text: string }
  | { kind: 'progress'; progress: ConversationProgress }
  | { kind: 'turn'; turn: ConversationTurn }
