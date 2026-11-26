import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { z } from 'zod'
import { chatTextLimit } from '../../../src/contracts/chat'
import type { ChatProgress, ChatSnapshot, ChatStreamEvent, ChatTurn } from '../../../src/contracts/chat'
import { readServerEvents } from '../../../src/contracts/event-stream'
import { HttpError, request } from './api'
import { StudyTurnMessage } from './StudyMaterials'

const DraftSchema = z.object({
  text: z.string(), requestId: z.uuid().optional(),
})
type Draft = z.infer<typeof DraftSchema>
type OutgoingMessage = { requestId: string; text: string }
const progressText: Record<ChatProgress, string> = {
  reading_sources: '正在读取原文…', checking_citations: '正在核对引文…',
}

function readDraft(key: string): Draft {
  try {
    const saved = DraftSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'))
    if (saved.success) return saved.data
  } catch { /* In private browsing a draft can still live in component state. */ }
  return { text: '' }
}

export function StudyChat({ learnerId, onUnauthorized }: {
  learnerId: string
  onUnauthorized: () => void
}) {
  const storageKey = 'human-epochs:study-draft:' + learnerId
  const [draft, setDraft] = useState(() => readDraft(storageKey))
  const currentDraft = useRef(draft)
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [sendError, setSendError] = useState('')
  const [sending, setSending] = useState<OutgoingMessage | null>(null)
  const [received, setReceived] = useState(false)
  const [preview, setPreview] = useState('')
  const [progress, setProgress] = useState<ChatProgress | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState('')
  const sendRequest = useRef<AbortController | null>(null)
  const stopRequest = useRef<AbortController | null>(null)
  const snapshotRequest = useRef<AbortController | null>(null)
  const [invalid, setInvalid] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const scrollPane = useRef<HTMLElement>(null)
  const followLatest = useRef(true)

  const saveDraft = useCallback((value: Draft) => {
    currentDraft.current = value
    setDraft(value)
    try {
      if (value.text) sessionStorage.setItem(storageKey, JSON.stringify(value))
      else sessionStorage.removeItem(storageKey)
    } catch { /* Editing and sending still work when browser storage is unavailable. */ }
  }, [storageKey])

  useEffect(() => {
    const controller = new AbortController()
    snapshotRequest.current = controller
    let poll: ReturnType<typeof setTimeout>
    async function load() {
      if (controller.signal.aborted) return
      try {
        const response = await request('/chat', { headers: { 'X-Learner-Id': learnerId }, signal: controller.signal })
        const data: ChatSnapshot = await response.json()
        if (controller.signal.aborted) return
        setSnapshot(data)
        setLoadError(false)
        if (data.turns.some(turn => turn.requestId === currentDraft.current.requestId)) {
          saveDraft({ text: '' })
          setSendError('')
        }
        if (data.turns.some(turn => turn.status === 'pending')) poll = setTimeout(load, 1500)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof HttpError && error.status === 401) onUnauthorized()
        else setLoadError(true)
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(poll) }
  }, [attempt, learnerId, onUnauthorized, saveDraft])

  useEffect(() => () => {
    sendRequest.current?.abort()
    sendRequest.current = null
    stopRequest.current?.abort()
  }, [])

  const turns = snapshot?.turns ?? []
  const latest = turns.at(-1)
  const activeTurn = latest?.status === 'pending' ? latest : null
  const stoppableId = sending ? (received ? sending.requestId : null) : activeTurn?.requestId
  const optimistic = sending && !turns.some(turn => turn.requestId === sending.requestId) ? sending : null
  const visibleTurns: ChatTurn[] = optimistic ? [...turns, { ...optimistic, content: null, status: 'pending' }] : turns
  const hasHistory = !!(latest || optimistic)
  const busy = !!(sending || activeTurn || stopping)
  const unavailable = !snapshot || loadError

  useLayoutEffect(() => {
    const pane = scrollPane.current
    if (pane && followLatest.current) pane.scrollTop = pane.scrollHeight
  }, [latest?.requestId, latest?.status, optimistic?.requestId, preview])

  function showTurn(turn: ChatTurn) {
    setSnapshot(current => {
      if (!current) return current
      const updated = current.turns.some(item => item.requestId === turn.requestId)
        ? current.turns.map(item => item.requestId === turn.requestId ? turn : item)
        : [...current.turns, turn]
      return { ...current, turns: updated }
    })
    if (currentDraft.current.requestId === turn.requestId) saveDraft({ text: '' })
  }

  async function stop(requestId: string) {
    if (stopRequest.current) return
    const controller = new AbortController()
    stopRequest.current = controller
    setStopping(true)
    setStopError('')
    field.current?.focus()
    try {
      const response = await request(`/chat/${requestId}/stop`, {
        method: 'POST', headers: { 'X-Learner-Id': learnerId }, signal: controller.signal,
      })
      const { turn }: { turn: ChatTurn } = await response.json()
      if (controller.signal.aborted) return
      snapshotRequest.current?.abort()
      if (turn.status !== 'pending' && sending?.requestId === requestId) sendRequest.current?.abort()
      showTurn(turn)
      setAttempt(value => value + 1)
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && error.status === 401) onUnauthorized()
      else {
        setStopError('暂时无法确认是否已停止。请查看回复状态后再试。')
        setAttempt(value => value + 1)
      }
    } finally {
      stopRequest.current = null
      if (!controller.signal.aborted) setStopping(false)
    }
  }

  async function send(message: OutgoingMessage) {
    if (sendRequest.current || busy || unavailable) return
    const controller = new AbortController()
    sendRequest.current = controller
    setSending(message)
    setSendError('')
    setStopError('')
    followLatest.current = true
    let receivedText = ''
    let frame: number | undefined
    try {
      const response = await request('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Learner-Id': learnerId },
        body: JSON.stringify(message),
        signal: controller.signal,
      })
      for await (const data of readServerEvents(response)) {
        if (controller.signal.aborted) return
        const event: ChatStreamEvent = JSON.parse(data)
        if (event.kind === 'received' && event.requestId === message.requestId) {
          setReceived(true)
          if (currentDraft.current.requestId === event.requestId) saveDraft({ text: '' })
        } else if (event.kind === 'delta') {
          receivedText += event.text
          frame ??= requestAnimationFrame(() => {
            frame = undefined
            if (!controller.signal.aborted) setPreview(receivedText)
          })
        } else if (event.kind === 'progress') {
          setProgress(event.progress)
        } else if (event.kind === 'turn' && event.turn.requestId === message.requestId) {
          snapshotRequest.current?.abort()
          showTurn(event.turn)
          return
        } else {
          throw new Error('Unexpected chat event')
        }
      }
      throw new Error('Chat stream ended before the final turn')
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && error.status === 401) {
        onUnauthorized()
        return
      }
      if (error instanceof HttpError && error.status === 400) {
        const detail = await error.response?.json().catch(() => null)
        if (controller.signal.aborted) return
        setSendError(detail?.message ?? '请检查消息内容后重新发送。')
      } else if (error instanceof HttpError && error.status === 409) {
        setSendError('对话已更新。请查看最新消息后再发送。')
      } else {
        setSendError('暂时无法确认回复。请查看对话记录后重试。')
      }
    } finally {
      if (frame !== undefined) cancelAnimationFrame(frame)
      if (sendRequest.current === controller) {
        sendRequest.current = null
        setSending(null)
        setReceived(false)
        setPreview('')
        setProgress(null)
        setAttempt(value => value + 1)
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || unavailable || sendRequest.current) return
    const text = draft.text.trim()
    if (!text) {
      setInvalid(true)
      field.current?.focus()
      return
    }
    const message = { requestId: draft.requestId ?? crypto.randomUUID(), text }
    saveDraft(message)
    field.current?.focus()
    void send(message)
  }

  function retry(turn: ChatTurn) {
    field.current?.focus()
    void send({ requestId: turn.requestId, text: turn.text })
  }

  return (
    <>
      <header className="conversation-header">
        <h1 id="workspace-heading">学习空间</h1>
        {snapshot && <span className="chat-mode">{snapshot.mode === 'guided' ? '本地学习引导' : '在线学习 Agent'}</span>}
      </header>
      <div className={hasHistory ? 'study-home has-history' : 'study-home'}>
        <section className="study-reading" ref={scrollPane} tabIndex={hasHistory ? 0 : undefined}
          aria-label="对话内容" onScroll={event => {
            const pane = event.currentTarget
            followLatest.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40
          }}>
          <div className="study-column">
            {!hasHistory && (
              <div className="study-welcome">
                <h2>今天想学什么？</h2>
                <p>{snapshot?.mode === 'guided' ? '说说你感兴趣的事，我们一起理清目标，找到可以先试的一步。' : '告诉 Agent 你想探索的主题，或者从一个具体的问题开始。'}</p>
              </div>
            )}
            <div className="study-log" role="log" aria-label="学习对话" aria-relevant="additions text">
              {visibleTurns.map(turn => <StudyTurnMessage key={turn.requestId} turn={turn}
                preview={turn.status !== 'stopped' && sending?.requestId === turn.requestId ? preview : undefined} status={
                <div className="turn-status">
                  {turn.status === 'stopped' ? '已停止回复。你可以继续发送消息。' :
                    turn.status === 'pending' || sending?.requestId === turn.requestId ?
                      (progress && sending?.requestId === turn.requestId ? progressText[progress] : '正在准备回复…') :
                    turn.status === 'retryable' ? <>
                      <span>这条消息已保存，回复未完成。</span>
                      <button type="button" disabled={busy || unavailable} onClick={() => retry(turn)}>重试回复</button>
                    </> : '这条消息已保存，回复未完成。你可以继续发送消息。'}
                </div>
              } />)}
            </div>
          </div>
        </section>
        <div className="study-compose-wrap study-column">
          {loadError && <div className="notice notice-error">
            <p role="alert">暂时无法读取学习对话。请检查网络连接后重试。</p>
            <button type="button" onClick={() => setAttempt(value => value + 1)}>重新读取对话</button>
          </div>}
          <form className="study-composer" onSubmit={submit}>
            <label htmlFor="study-message" className="sr-only">对话消息</label>
            <textarea ref={field} id="study-message" rows={2} maxLength={chatTextLimit}
              value={sending && draft.requestId === sending.requestId ? '' : draft.text}
              placeholder={hasHistory ? '继续聊聊你的想法…' : '比如，我想学会看懂一张星图'}
              aria-invalid={invalid || undefined} aria-describedby={sendError || invalid ? 'study-send-error' : 'study-send-help'}
              readOnly={!!sending} onChange={event => {
                saveDraft({ text: event.target.value })
                setSendError('')
                setInvalid(false)
              }} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }} />
            <div className="study-toolbar">
              <span id="study-send-help">{!snapshot && !loadError ? '正在读取学习对话…' : busy ? '这条消息结束后可以继续发送。' : 'Enter 发送 · Shift + Enter 换行'}</span>
              {stoppableId ? <button type="button" disabled={stopping} onClick={() => void stop(stoppableId)}>
                {stopping ? '正在停止…' : '停止回复'}
              </button> : <button type="submit" disabled={busy || unavailable} aria-label="发送消息">发送<span aria-hidden="true">↑</span></button>}
            </div>
          </form>
          {stopError && <p role="alert" className="form-error">{stopError}</p>}
          {(sendError || invalid) && <p id="study-send-error" role="alert" className="form-error">{invalid ? '请先写下想学的主题或问题。' : sendError}</p>}
        </div>
      </div>
    </>
  )
}
