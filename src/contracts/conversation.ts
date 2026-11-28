import { z } from 'zod'
import { goalNoteLimit, goalTitleLimit } from './learning-goal.js'
import type { PersonalMemorySnapshot } from './personal-memory.js'

export const conversationTextLimit = 4000
// One material discussion may hold this many sources and characters in total. A single pasted source may use all of it.
export const materialSourceLimit = 16
export const materialTextLimit = 500000
// The opening of a source shown with a turn. The full text stays in the material store.
export const materialPreviewLimit = 600
export const materialLabelLimit = 120

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
  excerpt: z.strictObject({ label: clean(materialLabelLimit), text: clean(materialTextLimit) }).optional(),
  // Materials already in the user's library, chosen instead of uploading the text again.
  materialIds: z.array(requestId).max(materialSourceLimit).optional(),
})
export type ConversationMaterialSelection = z.infer<typeof conversationMaterialSelectionSchema>

export const sendConversationCommandSchema = z.strictObject({
  conversationId: requestId,
  requestId,
  messageText: clean(conversationTextLimit),
  materialSelection: conversationMaterialSelectionSchema.optional(),
  reviewInvitationId: requestId.optional(),
}).refine(message => !(message.reviewInvitationId && message.materialSelection))
export type SendConversationCommand = z.infer<typeof sendConversationCommandSchema>

// What a turn shows about each source it read: the name, total length and the opening of the text.
export interface MaterialSourceView {
  id: string
  label: string
  length: number
  preview: string
  truncated: boolean
  // The user deleted this material; its name, opening and text are gone.
  deleted: boolean
}

export interface ConversationMaterialContext {
  discussionVersion: string | null
  discussionId: string
  sources: MaterialSourceView[]
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
  // Material explanations require citations. Ordinary conversation has no source, so its views carry none.
  citations: z.array(citationSchema).min(1).optional(),
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

export const diagramLimits = { nodes: 12, edges: 20, label: 24, edgeLabel: 16, title: 120 } as const
const diagramFields = {
  kind: z.literal('diagram'),
  title: clean(diagramLimits.title),
  nodes: z.array(z.strictObject({ id: localId, label: clean(diagramLimits.label) })).min(2).max(diagramLimits.nodes),
  // Edges are directed. Their order is the reading order of the text view.
  edges: z.array(z.strictObject({
    from: localId, to: localId, label: clean(diagramLimits.edgeLabel).optional(),
  })).min(1).max(diagramLimits.edges),
  citations: z.array(citationSchema).min(1).optional(),
}
type DiagramShape = { nodes: { id: string }[]; edges: { from: string; to: string }[] }

export function diagramProblem({ nodes, edges }: DiagramShape): string | null {
  const known = new Set(nodes.map(node => node.id))
  if (known.size !== nodes.length) return 'duplicate_node'
  if (edges.some(edge => !known.has(edge.from) || !known.has(edge.to))) return 'unknown_node'
  if (edges.some(edge => edge.from === edge.to)) return 'self_edge'
  if (new Set(edges.map(edge => edge.from + '\u0000' + edge.to)).size !== edges.length) return 'duplicate_edge'
  return null
}
const diagramBlock = z.strictObject(diagramFields).refine(block => !diagramProblem(block), { message: 'Invalid diagram edges' })

// A learning goal the Agent suggests in ordinary conversation. It becomes a goal only when the user accepts it.
const goalProposalFields = {
  kind: z.literal('goal_proposal'),
  title: z.string().trim().min(1).max(goalTitleLimit),
  motivation: z.string().trim().max(goalNoteLimit).default(''),
}
const goalProposalBlock = z.strictObject(goalProposalFields)

export const conversationContentDraftSchema = z.discriminatedUnion('kind', [textBlock, excerptBlock, eventLogBlock, diagramBlock, goalProposalBlock])
export const conversationContentSchema = z.array(z.discriminatedUnion('kind', [
  textBlock.extend({ id: z.uuid() }),
  excerptBlock.extend({ id: z.uuid() }),
  z.strictObject({ ...eventLogFields, id: z.uuid() }).refine(block => !eventLogProblem(block), { message: 'Invalid event log references' }),
  z.strictObject({ ...diagramFields, id: z.uuid() }).refine(block => !diagramProblem(block), { message: 'Invalid diagram edges' }),
  z.strictObject({ ...goalProposalFields, id: z.uuid() }),
  z.strictObject({ kind: z.literal('unavailable'), id: z.uuid() }),
])).min(1).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length)

export type ConversationCitation = z.infer<typeof citationSchema>
export type ConversationContentDraft = z.infer<typeof conversationContentDraftSchema>
export type ConversationContent = z.infer<typeof conversationContentSchema>
export type EventLogBlock = Extract<ConversationContentDraft, { kind: 'event_log' }>
export type DiagramBlock = Extract<ConversationContentDraft, { kind: 'diagram' }>
export type GoalProposalBlock = Extract<ConversationContentDraft, { kind: 'goal_proposal' }>

// The text view keeps every relation in order and lists nodes that have no relation, so it carries the whole diagram.
export function diagramLines(block: Pick<DiagramBlock, 'nodes' | 'edges'>) {
  const label = new Map(block.nodes.map(node => [node.id, node.label]))
  const connected = new Set(block.edges.flatMap(edge => [edge.from, edge.to]))
  const relations = block.edges.map(edge =>
    `${label.get(edge.from)} → ${label.get(edge.to)}${edge.label ? `（${edge.label}）` : ''}`)
  return [...relations, ...block.nodes.filter(node => !connected.has(node.id)).map(node => node.label)]
}

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
    if (block.kind === 'diagram') return [[block.title, ...diagramLines(block).map(line => '- ' + line)].join('\n')]
    // The model sees what it proposed, so it does not propose the same goal again.
    if (block.kind === 'goal_proposal') return [`（提议设为学习目标：${block.title}）`]
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
  // Personal memories the published reply was given. Only the conversation snapshot carries them.
  memoryIds?: string[]
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
  // The conversation where the reviewed discussion happened. Reviews can be answered in any conversation.
  conversationTitle: string | null
}

export const reviewInvitationCommandSchema = z.strictObject({
  conversationId: z.uuid().toLowerCase(), commandId: z.uuid().toLowerCase(), reviewInvitationId: z.uuid().toLowerCase(),
  action: z.enum(['accept', 'later', 'stop']),
})
export type ReviewInvitationCommand = z.infer<typeof reviewInvitationCommandSchema>

export interface ConversationListItem {
  conversationId: string
  title: string
  updatedAt: string
}

export interface ConversationList {
  conversations: ConversationListItem[]
}

export const conversationTitleLimit = 40

// A conversation is titled by its first message, on one line and cut to the title limit.
export function conversationTitle(text: string) {
  const line = text.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(line)
  return characters.length > conversationTitleLimit ? characters.slice(0, conversationTitleLimit - 1).join('') + '…' : line
}

// Rename and delete carry a stable command ID. A replayed command returns the current list without acting again.
export const conversationCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('rename'), commandId: z.uuid().toLowerCase(), title: clean(conversationTitleLimit) }),
  z.strictObject({ operation: z.literal('delete'), commandId: z.uuid().toLowerCase() }),
])
export type ConversationCommand = z.infer<typeof conversationCommandSchema>

// A conversation that has no turns yet is a new conversation: it has an ID but no title until its first message.
export interface ConversationSnapshot extends PersonalMemorySnapshot {
  conversationId: string
  title: string | null
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
