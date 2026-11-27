import { materialSourceLimit, materialTextLimit } from '../../../src/contracts/conversation'
import type { ConversationMaterialSelection, ConversationTurn } from '../../../src/contracts/conversation'

export interface Attachment {
  label: string
  text: string
}

export interface ActiveDiscussion {
  requestId: string
  labels: string[]
  sourceCount: number
  textLength: number
}

// A new message continues the discussion of the latest finished turn when that turn discussed material. It is
// worked out from the published turns, so every device and every reload agree on it.
export function activeDiscussion(turns: readonly ConversationTurn[]): ActiveDiscussion | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    if (turn.status !== 'complete') continue
    if (turn.kind !== 'user' || !turn.materialContext) return null
    const { sources } = turn.materialContext
    return {
      requestId: turn.requestId,
      labels: sources.map(source => source.label),
      sourceCount: sources.length,
      textLength: sources.reduce((size, source) => size + source.text.length, 0),
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
  return { ...(parentRequestId ? { parentRequestId } : {}), ...(attachment ? { excerpt: attachment } : {}) }
}

export function describeLabels(labels: readonly string[]) {
  return labels.length > 2 ? `${labels.slice(0, 2).join('、')} 等 ${labels.length} 份` : labels.join('、')
}
