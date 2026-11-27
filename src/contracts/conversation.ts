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

export const eventLogViews = ['sequence', 'list'] as const
export const eventLogLimits = { participants: 6, events: 16, label: 40, text: 200, title: 120 } as const
const localId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u)
const eventLogFields = {
  kind: z.literal('event_log'),
  title: clean(eventLogLimits.title),
  view: z.enum(eventLogViews),
  participants: z.array(z.strictObject({ id: localId, label: clean(eventLogLimits.label) })).min(1).max(eventLogLimits.participants),
  // Events are kept in their public order. `to` is omitted for an action inside one participant.
  events: z.array(z.strictObject({
    id: localId, from: localId, to: localId.optional(), text: clean(eventLogLimits.text),
  })).min(1).max(eventLogLimits.events),
  citations: z.array(citationSchema).min(1),
}
type EventLogShape = { participants: { id: string }[]; events: { id: string; from: string; to?: string }[] }

// Every view draws from the same participants and events, so a broken reference is rejected before any view renders.
export function eventLogProblem({ participants, events }: EventLogShape): string | null {
  const known = new Set(participants.map(item => item.id))
  if (known.size !== participants.length) return 'duplicate_participant'
  if (new Set(events.map(item => item.id)).size !== events.length) return 'duplicate_event'
  if (events.some(event => !known.has(event.from) || (event.to !== undefined && !known.has(event.to)))) return 'unknown_participant'
  return null
}
const eventLogBlock = z.strictObject(eventLogFields).refine(block => !eventLogProblem(block), { message: 'Invalid event log references' })

export const conversationContentDraftSchema = z.discriminatedUnion('kind', [textBlock, excerptBlock, eventLogBlock])
export const conversationContentSchema = z.array(z.discriminatedUnion('kind', [
  textBlock.extend({ id: z.uuid() }),
  excerptBlock.extend({ id: z.uuid() }),
  z.strictObject({ ...eventLogFields, id: z.uuid() }).refine(block => !eventLogProblem(block), { message: 'Invalid event log references' }),
  z.strictObject({ kind: z.literal('unavailable'), id: z.uuid() }),
])).min(1).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length)

export type ConversationCitation = z.infer<typeof citationSchema>
export type ConversationContentDraft = z.infer<typeof conversationContentDraftSchema>
export type ConversationContent = z.infer<typeof conversationContentSchema>
export type EventLogBlock = Extract<ConversationContentDraft, { kind: 'event_log' }>

export function eventLogLines(block: Pick<EventLogBlock, 'participants' | 'events'>) {
  const label = new Map(block.participants.map(item => [item.id, item.label]))
  return block.events.map(event => {
    const from = label.get(event.from) ?? event.from
    const to = event.to && event.to !== event.from ? label.get(event.to) ?? event.to : undefined
    return { id: event.id, actors: to ? `${from} → ${to}` : from, text: event.text }
  })
}

export function conversationContentText(content: readonly ConversationContentDraft[] | ConversationContent | null): string | null {
  if (!content) return null
  return content.flatMap(block => {
    if (block.kind === 'text') return [block.text]
    if (block.kind === 'excerpt') return [block.source.quote]
    if (block.kind === 'event_log') {
      const lines = eventLogLines(block).map((line, index) => `${index + 1}. ${line.actors}：${line.text}`)
      return [[block.title, ...lines].join('\n')]
    }
    return []
  }).join('\n\n') || null
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
