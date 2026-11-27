import { materialSourceLimit, materialTextLimit } from '../../../src/contracts/conversation'
import type { ConversationMaterialSelection, ConversationTurn } from '../../../src/contracts/conversation'

// A source for the next message: text the user just pasted or read from a file, or a material already in the library.
export type Attachment = { label: string; text: string } | { materialId: string; label: string; length: number }

export const attachmentLength = (attachment: Attachment) => 'text' in attachment ? attachment.text.length : attachment.length

export interface ActiveDiscussion {
  requestId: string
  labels: string[]
  sourceCount: number
  textLength: number
  // Source IDs already in the discussion, so the library can mark materials that are already being read.
  sourceIds: string[]
}

// A new message continues the discussion of the latest finished turn when that turn discussed material. It is
// worked out from the published turns, so every device and every reload agree on it.
export function activeDiscussion(turns: readonly ConversationTurn[]): ActiveDiscussion | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    if (turn.status !== 'complete') continue
    if (turn.kind !== 'user' || !turn.materialContext) return null
    // Deleted materials cannot be read again; a discussion left with none cannot be continued.
    const sources = turn.materialContext.sources.filter(source => !source.deleted)
    if (!sources.length) return null
    return {
      requestId: turn.requestId,
      labels: sources.map(source => source.label),
      sourceCount: sources.length,
      textLength: sources.reduce((size, source) => size + source.length, 0),
      sourceIds: sources.map(source => source.id),
    }
  }
  return null
}

// What is left for a new source once the continued discussion's sources are counted.
export function materialBudget(discussion: ActiveDiscussion | null) {
  return {
    text: materialTextLimit - (discussion?.textLength ?? 0),
    sources: materialSourceLimit - (discussion?.sourceCount ?? 0),
  }
}

export function materialSelectionFor(
  discussion: ActiveDiscussion | null, attachment: Attachment | undefined, leaveDiscussion: boolean,
): ConversationMaterialSelection | undefined {
  const parentRequestId = discussion && !leaveDiscussion ? discussion.requestId : undefined
  if (!parentRequestId && !attachment) return undefined
  const source = !attachment ? {} : 'text' in attachment ? { excerpt: attachment } : { materialIds: [attachment.materialId] }
  return { ...(parentRequestId ? { parentRequestId } : {}), ...source }
}

export function describeLabels(labels: readonly string[]) {
  return labels.length > 2 ? `${labels.slice(0, 2).join('、')} 等 ${labels.length} 份` : labels.join('、')
}
