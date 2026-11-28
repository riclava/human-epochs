import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { conversationTextLimit } from '../../../src/contracts/conversation'
import type { ConversationProgress, ConversationSnapshot, ConversationTurn, ReviewInvitationCommand } from '../../../src/contracts/conversation'
import { ConversationTurnMessage } from './ConversationTurnMessage'
import { PersonalMemorySection } from './PersonalMemorySection'
import { ReviewInvitationCard } from './ReviewInvitationCard'
import { useConversationSession, type UnsentMessage } from './useConversationSession'
import { activeDiscussion, materialBudget, materialSelectionFor } from './material-draft'
import { AttachMaterialDialog } from './AttachMaterialDialog'
import { MaterialStatus } from './MaterialComposer'
import { GoalProposalsContext } from './GoalProposalCard'
import { useLearningGoals } from './learning-goals-client'
import { useTurnTarget } from './useTurnTarget'
import { ConversationGoalPicker } from './ConversationGoalPicker'
import type { WorkspacePageProps } from './workspace-pages'

function groupBySource<T extends { sourceRequestId: string | null }>(records: readonly T[]) {
  const groups = new Map<string | null, T[]>()
  for (const record of records) {
    const group = groups.get(record.sourceRequestId)
    if (group) group.push(record)
    else groups.set(record.sourceRequestId, [record])
  }
  return groups
}

const progressText: Record<ConversationProgress, string> = {
  reading_sources: '正在读取原文…', checking_citations: '正在核对引文…',
}

function ReplyStatus({ status, progress, retry, canSend }: {
  status: ConversationTurn['status']
  progress?: ConversationProgress
  retry: () => void
  canSend: boolean
}) {
  if (status === 'complete') return null
  const messages = {
    pending: progress ? progressText[progress] : '正在准备回复…',
    retryable: '这条消息已保存，回复未完成。',
    failed: '这条消息已保存，回复未完成。你可以继续发送消息。',
    stopped: '已停止回复。你可以继续发送消息。',
  }
  return <div className="turn-status">
    <span>{messages[status]}</span>
    {status === 'retryable' && <button type="button" disabled={!canSend} onClick={retry}>重试回复</button>}
  </div>
}

export function ConversationView(props: WorkspacePageProps) {
  // The workspace replaces "#/" with a conversation address, so this state lasts only a moment.
  if (!props.conversationId) return <header className="conversation-header"><h1 id={props.heading.id}>{props.heading.text}</h1></header>
  return <ConversationPane {...props} conversationId={props.conversationId} />
}

function ConversationPane({ userId, onUnauthorized, heading, conversationId, onConversationsChanged, conversationTitle }:
  WorkspacePageProps & { conversationId: string }) {
  const conversation = useConversationSession(userId, conversationId, onUnauthorized)
  const learningGoals = useLearningGoals(userId, onUnauthorized)
  const refreshConversation = conversation.refresh
  // Accepting a proposal may put this conversation under the new goal, so the heading reads the goal again.
  const goalProposals = useMemo(() => ({
    goals: learningGoals.goals,
    run: async (command: Parameters<typeof learningGoals.run>[0]) => {
      const problem = await learningGoals.run(command)
      if (!problem && command.operation === 'create' && command.proposal) refreshConversation()
      return problem
    },
  }), [learningGoals.goals, learningGoals.run, refreshConversation])
  const { snapshot, draft, latest, items, busy, canSend, activeId, controls, hasHistory, loadError, sendError, stopError } = conversation
  // The sidebar shows titles and recency, which change when this conversation gains a turn.
  const turnCount = snapshot?.turns.length ?? 0
  useEffect(() => { if (turnCount) onConversationsChanged() }, [turnCount, onConversationsChanged])
  const [reviewStatus, setReviewStatus] = useState('')
  const [dismissedReviewInvitation, setDismissedReviewInvitation] = useState<string>()
  const [invalid, setInvalid] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
  const scrollPane = useRef<HTMLElement>(null)
  const followLatest = useRef(true)

  const reviewInvitation = !loadError && snapshot?.reviewInvitation?.reviewInvitationId !== dismissedReviewInvitation
    ? snapshot?.reviewInvitation : undefined
  const activeReviewInvitationId = latest?.kind === 'review_question' ? latest.reviewInvitationId : undefined
  const memoriesBySource = useMemo(() => groupBySource(snapshot?.memories ?? []), [snapshot?.memories])
  const candidatesBySource = useMemo(() => groupBySource(snapshot?.candidates ?? []), [snapshot?.candidates])
  const discussion = useMemo(() => activeDiscussion(snapshot?.turns ?? []), [snapshot?.turns])
  const memoriesById = useMemo(() => new Map((snapshot?.memories ?? []).map(record => [record.id, record])), [snapshot?.memories])
  const memoryActions = { userId, onUnauthorized, onSaved: conversation.memorySaved, onReload: conversation.refresh }

  useLayoutEffect(() => {
    const pane = scrollPane.current
    if (pane && followLatest.current) pane.scrollTop = pane.scrollHeight
  }, [latest?.requestId, latest?.status, activeId, conversation.scrollPreview, reviewInvitation?.reviewInvitationId])

  const targetTurn = useTurnTarget(!!snapshot, followLatest)
  const startingGoal = draft.goalId ? learningGoals.goals?.find(goal => goal.id === draft.goalId) : undefined

  function send(message: UnsentMessage) {
    if (!canSend) return
    setReviewStatus('')
    if (reviewInvitation) setDismissedReviewInvitation(reviewInvitation.reviewInvitationId)
    followLatest.current = true
    field.current?.focus()
    void conversation.send(message)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSend) return
    const messageText = draft.messageText.trim()
    if (!messageText) {
      setInvalid(true)
      field.current?.focus()
      return
    }
    // A message that was saved but not confirmed is sent again exactly as before.
    const reviewInvitationId = draft.requestId ? draft.reviewInvitationId : activeReviewInvitationId
    const materialSelection = draft.requestId ? draft.materialSelection
      : reviewInvitationId ? undefined : materialSelectionFor(discussion, draft.attachment, !!draft.leaveDiscussion)
    const goalId = hasHistory ? undefined : draft.goalId
    const message = { requestId: draft.requestId ?? crypto.randomUUID(), messageText, reviewInvitationId, materialSelection, ...(goalId ? { goalId } : {}) }
    conversation.saveDraft({ ...draft, ...message })
    send(message)
  }

  function finishReview(data: ConversationSnapshot, action: ReviewInvitationCommand['action'], restoreFocus: boolean) {
    if (action === 'accept') followLatest.current = true
    conversation.acceptSnapshot(data)
    setReviewStatus(action === 'later' ? '一天后再提醒你。' : action === 'stop' ? '已停止主动复习提醒。' : '')
    if (restoreFocus) field.current?.focus()
  }

  function startMaterial(starter: NonNullable<ConversationSnapshot['starter']>) {
    if (!canSend) return
    const message = { requestId: crypto.randomUUID(), messageText: starter.question, materialSelection: { discussionVersion: starter.discussionVersion } }
    conversation.saveDraft(message)
    send(message)
  }

  if (conversation.deleted) return <>
    <header className="conversation-header"><h1 id={heading.id}>对话已删除</h1></header>
    <div className="conversation-body"><div className="conversation-column conversation-deleted notice">
      <p role="status">这个对话已删除，消息和回复都已清除。</p>
      <a href="#/">打开最近的对话</a>
    </div></div>
  </>

  return (
    <GoalProposalsContext.Provider value={goalProposals}>
      <header className="conversation-header">
        <h1 id={heading.id}>{snapshot ? conversationTitle ?? snapshot.title ?? '新对话' : heading.text}</h1>
        {snapshot && <span className="conversation-mode">{snapshot.mode === 'guided' ? '本地引导' : '在线模型'}</span>}
        {snapshot?.title && <ConversationGoalPicker userId={userId} conversationId={snapshot.conversationId} goalId={snapshot.goalId}
          onUnauthorized={onUnauthorized} onChanged={() => { conversation.refresh(); void learningGoals.reload() }} />}
      </header>
      <div className={hasHistory ? 'conversation-body has-history' : 'conversation-body'}>
        <section className="conversation-reading" ref={scrollPane} tabIndex={hasHistory ? 0 : undefined}
          aria-label="对话内容" onScroll={event => {
            const pane = event.currentTarget
            followLatest.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40
          }}>
          <div className="conversation-column">
            {!hasHistory && (
              <div className="conversation-welcome">
                <h2>从一个问题开始</h2>
                <p>{snapshot?.mode === 'guided' ? '说说你想弄懂什么，一起理清目标和第一步。' : '可以直接提问，也可以贴一段原文来讨论。'}</p>
                {startingGoal && <p className="conversation-goal-note">这段对话会归入学习目标「{startingGoal.title}」。</p>}
                {snapshot?.starter && !draft.messageText && <button className="conversation-starter" type="button" disabled={!canSend}
                  onClick={() => startMaterial(snapshot.starter!)}>聊聊《{snapshot.starter.title}》</button>}
              </div>
            )}
            {snapshot && <PersonalMemorySection {...memoryActions} memories={memoriesBySource.get(null) ?? []}
              suggestionsEnabled={snapshot.suggestionsEnabled} />}
            <div className="conversation-log" role="log" aria-label="对话记录" aria-relevant="additions text">
              {items.map(({ turn, status, preview, progress }) => <ConversationTurnMessage key={turn.requestId} turn={turn} targeted={turn.requestId === targetTurn}
                usedMemories={turn.kind === 'user' ? (turn.memoryIds ?? []).flatMap(id => memoriesById.get(id) ?? []) : []}
                memory={turn.status === 'complete' && turn.kind === 'user' && <PersonalMemorySection {...memoryActions}
                  source={turn} memories={memoriesBySource.get(turn.requestId) ?? []}
                  candidates={candidatesBySource.get(turn.requestId) ?? []} />}
                preview={preview} status={turn.kind === 'user' && <ReplyStatus status={status} progress={progress} canSend={canSend}
                  retry={() => send({ requestId: turn.requestId, messageText: turn.messageText })} />} />)}
            </div>
          </div>
        </section>
        <div className="conversation-compose-wrap conversation-column">
          {loadError && <div className="notice notice-error">
            <p role="alert">暂时无法读取对话。请检查网络连接后重试。</p>
            <button type="button" onClick={conversation.refresh}>重新读取对话</button>
          </div>}
          {reviewInvitation && <ReviewInvitationCard key={reviewInvitation.reviewInvitationId} invitation={reviewInvitation} userId={userId}
            conversationId={conversationId} disabled={busy}
            onUnauthorized={onUnauthorized} onResult={finishReview} onStale={restoreFocus => {
              setDismissedReviewInvitation(reviewInvitation.reviewInvitationId)
              setReviewStatus('复习邀请已更新。')
              conversation.refresh()
              if (restoreFocus) field.current?.focus()
            }} />}
          <p className="review-status" role="status">{reviewStatus}</p>
          <form className="conversation-composer" onSubmit={submit}>
            <MaterialStatus attachment={draft.requestId ? undefined : draft.attachment} discussion={activeReviewInvitationId ? null : discussion}
              leaveDiscussion={!!draft.leaveDiscussion} disabled={!!activeId}
              onRemove={() => { conversation.saveDraft({ ...draft, requestId: undefined, attachment: undefined }); field.current?.focus() }}
              onLeave={() => { conversation.saveDraft({ ...draft, requestId: undefined, leaveDiscussion: true }); field.current?.focus() }}
              onContinue={() => { conversation.saveDraft({ ...draft, requestId: undefined, leaveDiscussion: undefined }); field.current?.focus() }} />
            <label htmlFor="conversation-message" className="sr-only">对话消息</label>
            <textarea ref={field} id="conversation-message" rows={2} maxLength={conversationTextLimit}
              value={activeId && draft.requestId === activeId ? '' : draft.messageText}
              placeholder={activeReviewInvitationId ? '说说你的答案…' : draft.attachment ? '问问这段原文…'
                : discussion && !draft.leaveDiscussion ? '接着问问这份材料…' : hasHistory ? '继续聊聊你的想法…' : '比如，我想学会看懂一张星图'}
              aria-invalid={invalid || undefined} aria-describedby={sendError || invalid ? 'conversation-send-error' : 'conversation-send-help'}
              readOnly={!!activeId} onChange={event => {
                conversation.saveDraft({ messageText: event.target.value, attachment: draft.attachment, leaveDiscussion: draft.leaveDiscussion, goalId: draft.goalId })
                conversation.clearSendError()
                setInvalid(false)
              }} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }} />
            <div className="conversation-toolbar">
              <span id="conversation-send-help">{!snapshot && !loadError ? '正在读取对话…' : busy ? '这条消息结束后可以继续发送。' : 'Enter 发送 · Shift + Enter 换行'}</span>
              <AttachMaterialDialog budget={materialBudget(draft.leaveDiscussion ? null : discussion)} disabled={busy || !!activeReviewInvitationId}
                inDiscussion={draft.leaveDiscussion ? [] : discussion?.sourceIds ?? []}
                onAttach={attachment => { conversation.saveDraft({ ...draft, requestId: undefined, attachment }); field.current?.focus() }} />
              {controls.kind === 'stop' ? <button type="button" disabled={controls.disabled} onClick={() => {
                field.current?.focus()
                void conversation.stop(controls.requestId)
              }}>{controls.disabled ? '正在停止…' : '停止回复'}</button>
                : <button type="submit" disabled={controls.disabled} aria-label="发送消息">发送<span aria-hidden="true">↑</span></button>}
            </div>
          </form>
          {stopError && <p role="alert" className="form-error">{stopError}</p>}
          {(sendError || invalid) && <p id="conversation-send-error" role="alert" className="form-error">{invalid ? '写下一条消息再发送。' : sendError}</p>}
        </div>
      </div>
    </GoalProposalsContext.Provider>
  )
}
