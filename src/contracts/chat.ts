import { z } from 'zod'

export const chatTextLimit = 4000

export type ChatMode = 'guided' | 'model'

export interface ChatSource {
  id: string
  label: string
  text: string
}

export interface ChatMaterialOption {
  version: string
  title: string
  question: string
  sources: ChatSource[]
  supplements: ChatSource[]
}

export interface ChatMaterialInput {
  version?: string
  parentRequestId?: string
  sourceIds?: string[]
  excerpt?: { label: string; text: string }
}

export interface ChatMaterialContext {
  version: string | null
  discussionId: string
  sources: ChatSource[]
}

const citationSchema = z.strictObject({ id: z.string().min(1), label: z.string(), quote: z.string().min(1) })
const textBlock = z.strictObject({
  kind: z.literal('text'), text: z.string().min(1), citations: z.array(citationSchema).optional(),
})
const excerptBlock = z.strictObject({ kind: z.literal('excerpt'), source: citationSchema })
const candidateSchema = z.discriminatedUnion('kind', [textBlock, excerptBlock])
export const chatContentSchema = z.array(z.discriminatedUnion('kind', [
  textBlock.extend({ id: z.uuid() }),
  excerptBlock.extend({ id: z.uuid() }),
  z.strictObject({ kind: z.literal('unavailable'), id: z.uuid() }),
])).min(1).refine(blocks => new Set(blocks.map(block => block.id)).size === blocks.length)

export type ChatCitation = z.infer<typeof citationSchema>
export type ChatContentDraft = z.infer<typeof candidateSchema>
export type ChatContent = z.infer<typeof chatContentSchema>

export function chatContentText(content: readonly ChatContentDraft[] | ChatContent | null): string | null {
  if (!content) return null
  return content.flatMap(block => block.kind === 'text' ? [block.text] :
    block.kind === 'excerpt' ? [block.source.quote] : []).join('\n\n') || null
}

export interface ChatTurn {
  requestId: string
  text: string
  content: ChatContent | null
  status: 'pending' | 'retryable' | 'failed' | 'stopped' | 'complete'
  material?: ChatMaterialContext
  explanationMode?: 'model' | 'course' | 'excerpt'
}

export interface ChatSnapshot {
  mode: ChatMode
  turns: ChatTurn[]
}

export type ChatProgress = 'reading_sources' | 'checking_citations'

export type ChatStreamEvent =
  | { kind: 'received'; requestId: string }
  | { kind: 'delta'; text: string }
  | { kind: 'progress'; progress: ChatProgress }
  | { kind: 'turn'; turn: ChatTurn }

export interface ActivityChatTurn {
  requestId: string
  revision: number
  text: string
  intent: 'message' | 'hint'
  reply: string | null
  status: 'pending' | 'complete' | 'conflict'
}
