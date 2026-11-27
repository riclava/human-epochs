import type { ConversationProgress, ConversationSnapshot, ConversationTurn, SendConversationCommand } from '../../../src/contracts/conversation'
import type { PersonalMemorySnapshot } from '../../../src/contracts/personal-memory'

type Exchange = { message: SendConversationCommand } & (
  | { phase: 'submitting' }
  | { phase: 'received'; preview: string; progress?: ConversationProgress }
)
type Failure = { action: 'send' | 'stop'; text: string }

interface Session {
  snapshot: ConversationSnapshot | null
  loadError: boolean
  // Another device or this one deleted the conversation.
  deleted: boolean
  exchange: Exchange | null
  stopping: string | null
  failure: Failure | null
}

type Event =
  | { type: 'snapshot'; snapshot: ConversationSnapshot; adoptedDraft?: boolean }
  | { type: 'load_failed' }
  | { type: 'deleted' }
  | { type: 'memory_saved'; snapshot: PersonalMemorySnapshot }
  | { type: 'sending'; message: SendConversationCommand }
  | { type: 'received'; requestId: string }
  | { type: 'preview'; requestId: string; text: string }
  | { type: 'progress'; requestId: string; progress: ConversationProgress }
  | { type: 'settled'; requestId: string; turn?: ConversationTurn; error?: string }
  | { type: 'stopping'; requestId: string }
  | { type: 'stop_finished'; requestId: string; turn?: ConversationTurn; error?: string }
  | { type: 'dismiss_send_error' }

export const initialConversationSession: Session = { snapshot: null, loadError: false, deleted: false, exchange: null, stopping: null, failure: null }

function replaceTurn(snapshot: ConversationSnapshot | null, turn?: ConversationTurn) {
  if (!snapshot || !turn) return snapshot
  const position = snapshot.turns.findIndex(item => item.requestId === turn.requestId)
  if (position < 0) return { ...snapshot, turns: [...snapshot.turns, turn] }
  const turns = snapshot.turns.slice()
  turns[position] = turn
  return { ...snapshot, turns }
}

export function reduceConversationSession(state: Session, event: Event): Session {
  const exchange = state.exchange
  switch (event.type) {
    case 'snapshot': return { ...state, snapshot: event.snapshot, loadError: false,
      failure: event.adoptedDraft && state.failure?.action === 'send' ? null : state.failure }
    case 'load_failed': return { ...state, loadError: true }
    case 'deleted': return { ...state, deleted: true, exchange: null }
    case 'memory_saved': return { ...state, snapshot: state.snapshot && { ...state.snapshot, ...event.snapshot } }
    case 'sending': return { ...state, exchange: { phase: 'submitting', message: event.message }, failure: null }
    case 'received':
      if (exchange?.phase !== 'submitting' || exchange.message.requestId !== event.requestId) return state
      return { ...state, exchange: { phase: 'received', message: exchange.message, preview: '' } }
    case 'preview':
    case 'progress':
      if (exchange?.phase !== 'received' || exchange.message.requestId !== event.requestId) return state
      return { ...state, exchange: event.type === 'preview' ? { ...exchange, preview: event.text } : { ...exchange, progress: event.progress } }
    case 'settled':
      if (exchange?.message.requestId !== event.requestId) return state
      return { ...state, exchange: null, snapshot: replaceTurn(state.snapshot, event.turn),
        failure: event.error ? { action: 'send', text: event.error } : state.failure }
    case 'stopping': return { ...state, stopping: event.requestId,
      failure: state.failure?.action === 'stop' ? null : state.failure }
    case 'stop_finished': {
      if (state.stopping !== event.requestId) return state
      const stoppedExchange = event.turn && event.turn.status !== 'pending' && exchange?.message.requestId === event.requestId
      return { ...state, stopping: null, exchange: stoppedExchange ? null : exchange,
        snapshot: replaceTurn(state.snapshot, event.turn), failure: event.error ? { action: 'stop', text: event.error } : state.failure }
    }
    case 'dismiss_send_error': return state.failure?.action === 'send' ? { ...state, failure: null } : state
  }
}

export function conversationSessionView({ snapshot, loadError, deleted, exchange, stopping, failure }: Session) {
  const turns = snapshot?.turns ?? []
  const latest = turns.at(-1)
  const pending = turns.find(turn => turn.status === 'pending')
  const activeId = exchange?.message.requestId
  const streaming = exchange?.phase === 'received' ? exchange : undefined
  const busy = !!(exchange || pending || stopping)
  const canSend = !!snapshot && !loadError && !busy
  const stopId = stopping ?? (exchange ? streaming?.message.requestId : pending?.requestId)
  const optimistic: ConversationTurn | undefined = exchange && !turns.some(turn => turn.requestId === activeId)
    ? { requestId: exchange.message.requestId, kind: 'user', messageText: exchange.message.messageText, status: 'pending', replyBlocks: null }
    : undefined
  const items = (optimistic ? [...turns, optimistic] : turns).map(turn => {
    const receiving = turn.kind === 'user' && turn.requestId === activeId && turn.status !== 'stopped' && !turn.replyBlocks
    const status = receiving ? 'pending' : turn.status
    return { turn, status, preview: receiving ? streaming?.preview : undefined, progress: receiving ? streaming?.progress : undefined }
  })
  return {
    snapshot, loadError, deleted, latest, items, hasHistory: items.length > 0, busy, canSend, activeId,
    scrollPreview: streaming?.preview,
    controls: stopId ? { kind: 'stop' as const, requestId: stopId, disabled: !!stopping }
      : { kind: 'send' as const, disabled: !canSend },
    sendError: failure?.action === 'send' ? failure.text : '', stopError: failure?.action === 'stop' ? failure.text : '',
  }
}
