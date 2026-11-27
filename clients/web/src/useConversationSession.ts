import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ConversationSnapshot, ConversationStreamEvent, ConversationTurn, SendConversationCommand } from '../../../src/contracts/conversation'
import { readServerEvents } from '../../../src/contracts/event-stream'
import type { PersonalMemorySnapshot } from '../../../src/contracts/personal-memory'
import { HttpError, request } from './api'
import { conversationSessionView, initialConversationSession, reduceConversationSession } from './conversation-session-state'
import { useConversationDraft } from './conversation-draft'

type Transfer = { requestId: string; controller: AbortController }

export type UnsentMessage = Omit<SendConversationCommand, 'conversationId'>

export function useConversationSession(userId: string, conversationId: string, onUnauthorized: () => void) {
  const [state, dispatch] = useReducer(reduceConversationSession, initialConversationSession)
  const [refreshCount, queueRefresh] = useState(0)
  const { draft, currentDraft, saveDraft } = useConversationDraft(userId, conversationId)
  const stream = useRef<Transfer | null>(null)
  const stopRequest = useRef<AbortController | null>(null)
  const snapshotRequest = useRef<AbortController | null>(null)
  const view = conversationSessionView(state)

  const refresh = useCallback(() => {
    snapshotRequest.current?.abort()
    queueRefresh(value => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    snapshotRequest.current = controller
    let poll: ReturnType<typeof setTimeout>
    // Suggestions arrive from a background job. Check a few times, then wait for the next refresh.
    let suggestionChecks = 0
    async function load() {
      if (controller.signal.aborted) return
      try {
        const response = await request('/conversations/' + conversationId, { headers: { 'X-User-Id': userId }, signal: controller.signal })
        const snapshot: ConversationSnapshot = await response.json()
        if (controller.signal.aborted) return
        const adoptedDraft = snapshot.turns.some(turn => turn.requestId === currentDraft.current.requestId)
        if (adoptedDraft) saveDraft({ messageText: '' })
        dispatch({ type: 'snapshot', snapshot, adoptedDraft })
        if (snapshot.turns.some(turn => turn.status === 'pending')) poll = setTimeout(load, 1500)
        else if (snapshot.suggestionsPending && suggestionChecks++ < 10) poll = setTimeout(load, 3000)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof HttpError && error.status === 401) onUnauthorized()
        else dispatch({ type: 'load_failed' })
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(poll) }
  }, [refreshCount, currentDraft, userId, conversationId, onUnauthorized, saveDraft])

  useEffect(() => {
    function onVisible() { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      stream.current?.controller.abort()
      stream.current = null
      stopRequest.current?.abort()
      stopRequest.current = null
    }
  }, [refresh])

  function clearDraft(requestId: string) {
    if (currentDraft.current.requestId === requestId) saveDraft({ messageText: '' })
  }

  async function send(unsent: UnsentMessage) {
    const message: SendConversationCommand = { ...unsent, conversationId }
    if (stream.current || stopRequest.current || !view.canSend) return
    const { requestId } = message
    const controller = new AbortController()
    stream.current = { requestId, controller }
    dispatch({ type: 'sending', message })
    let receivedText = ''
    let frame: number | undefined
    let turn: ConversationTurn | undefined
    let failure: string | undefined
    try {
      const response = await request('/conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-User-Id': userId },
        body: JSON.stringify(message), signal: controller.signal,
      })
      for await (const data of readServerEvents(response)) {
        if (controller.signal.aborted) return
        const event: ConversationStreamEvent = JSON.parse(data)
        if (event.kind === 'received' && event.requestId === requestId) {
          dispatch({ type: 'received', requestId })
          clearDraft(requestId)
        } else if (event.kind === 'delta') {
          receivedText += event.text
          frame ??= requestAnimationFrame(() => {
            frame = undefined
            if (!controller.signal.aborted) dispatch({ type: 'preview', requestId, text: receivedText })
          })
        } else if (event.kind === 'progress') {
          dispatch({ type: 'progress', requestId, progress: event.progress })
        } else if (event.kind === 'turn' && event.turn.requestId === requestId) {
          turn = event.turn
          clearDraft(requestId)
          return
        } else throw new Error('Unexpected conversation event')
      }
      throw new Error('Conversation stream ended before the final turn')
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && error.status === 401) { onUnauthorized(); return }
      failure = await sendFailure(error, controller.signal)
      if (!controller.signal.aborted && error instanceof HttpError && error.status === 409 && message.reviewInvitationId &&
        currentDraft.current.requestId === requestId) saveDraft({ messageText: message.messageText })
    } finally {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (stream.current?.controller === controller) {
        stream.current = null
        dispatch({ type: 'settled', requestId, turn, error: failure })
        refresh()
      }
    }
  }

  async function stop(requestId: string) {
    if (stopRequest.current) return
    const controller = new AbortController()
    stopRequest.current = controller
    dispatch({ type: 'stopping', requestId })
    let turn: ConversationTurn | undefined
    let error: string | undefined
    try {
      const response = await request('/conversation/' + requestId + '/stop', {
        method: 'POST', headers: { 'X-User-Id': userId }, signal: controller.signal,
      })
      const result: { turn: ConversationTurn } = await response.json()
      if (controller.signal.aborted) return
      turn = result.turn
      if (turn.status !== 'pending' && stream.current?.requestId === requestId) {
        stream.current.controller.abort()
        stream.current = null
      }
      clearDraft(requestId)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof HttpError && cause.status === 401) { onUnauthorized(); return }
      error = '暂时无法确认是否已停止。请查看回复状态后再试。'
    } finally {
      if (stopRequest.current === controller) {
        stopRequest.current = null
        dispatch({ type: 'stop_finished', requestId, turn, error })
        refresh()
      }
    }
  }

  return { ...view, draft, saveDraft, send, stop, refresh,
    clearSendError: () => dispatch({ type: 'dismiss_send_error' }),
    memorySaved: (snapshot: PersonalMemorySnapshot) => { dispatch({ type: 'memory_saved', snapshot }); refresh() },
    acceptSnapshot: (snapshot: ConversationSnapshot) => { dispatch({ type: 'snapshot', snapshot }); refresh() },
  }
}

async function sendFailure(error: unknown, signal: AbortSignal) {
  if (error instanceof HttpError && error.status === 400) {
    const detail = await error.response?.json().catch(() => null)
    if (signal.aborted) return
    return detail?.message ?? '请检查消息内容后重新发送。'
  }
  if (error instanceof HttpError && error.status === 409) return '对话已更新。请查看最新消息后再发送。'
  return '暂时无法确认回复。请查看对话记录后重试。'
}
