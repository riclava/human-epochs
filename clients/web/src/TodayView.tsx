import { useCallback, useEffect, useState } from 'react'
import type { TodayGoal, TodayPending, TodayView as Today } from '../../../src/contracts/today'
import { HttpError, request } from './api'
import { startConversationUnderGoal } from './conversation-draft'
import { conversationHref, conversationTurnHref } from './routes'
import type { WorkspacePageProps } from './workspace-pages'

const resultText = { recalled: '独立答出', partial: '部分答出', forgotten: '没想起来' }
const pendingLabel: Record<TodayPending['kind'], string> = { goal_proposal: '目标提议', goal_progress: '进展提议', memory_candidate: '记忆提议' }

function GoalRow({ goal, userId }: { goal: TodayGoal; userId: string }) {
  const facts = [goal.dueReviews > 0 && `${goal.dueReviews} 个复习已到期`, goal.latestResult && `最近一次复习：${resultText[goal.latestResult]}`].filter(Boolean)
  // A goal without conversations starts a new one that belongs to it from the first message.
  function startNew() {
    const conversationId = crypto.randomUUID()
    startConversationUnderGoal(userId, conversationId, goal.id)
    window.location.hash = conversationHref(conversationId)
  }
  return <li className="today-goal">
    <h3>{goal.title}</h3>
    <p>{goal.progress || '还没有写下进展。'}</p>
    {facts.length > 0 && <p className="today-meta">{facts.join(' · ')}</p>}
    {goal.conversationId
      ? <a className="button-link" href={conversationHref(goal.conversationId)} aria-label={`接着学：${goal.title}`}>接着学</a>
      : <button type="button" onClick={startNew} aria-label={`开始学：${goal.title}`}>开始学</button>}
  </li>
}

export function TodayView({ userId, onUnauthorized, heading }: WorkspacePageProps) {
  const [today, setToday] = useState<Today | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [newConversationId] = useState(() => crypto.randomUUID())

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await request('/today', { headers: { 'X-User-Id': userId }, signal })
      setToday(await response.json() as Today)
      setLoadError(false)
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof HttpError && error.status === 401) onUnauthorized()
      else setLoadError(true)
    }
  }, [userId, onUnauthorized])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  return <div className="settings-content today-page">
    <header className="settings-heading">
      <h1 id={heading.id} tabIndex={-1}>{heading.text}</h1>
      <p>到期的复习、进行中的目标和还没处理的提议都在这里，从任意一项接着学。</p>
    </header>
    {loadError && <div className="notice notice-error">
      <p role="alert">暂时无法读取今天的安排。请检查网络连接后重试。</p>
      <button type="button" onClick={() => void load()}>重新读取</button>
    </div>}
    {today && <>
      {today.review && <section className="today-section today-review" aria-labelledby="today-review">
        <h2 id="today-review">复习到期</h2>
        <p><strong>{today.review.topic}</strong>（{today.review.sourceLabel}）</p>
        <p className="today-meta">出自「{today.review.conversationTitle}」，回到这段对话就能开始。</p>
        <a className="button-link primary-link" href={conversationHref(today.review.conversationId)}>开始复习</a>
      </section>}
      <section className="today-section" aria-labelledby="today-goals">
        <h2 id="today-goals">进行中的目标</h2>
        {today.goals.length
          ? <ul className="today-goals">{today.goals.map(goal => <GoalRow key={goal.id} goal={goal} userId={userId} />)}</ul>
          : <p className="learning-empty">还没有进行中的目标。<a href="#/goals">添加学习目标</a>后，可以从这里接着学。</p>}
      </section>
      {today.pending.length > 0 && <section className="today-section" aria-labelledby="today-pending">
        <h2 id="today-pending">待确认</h2>
        <ul className="today-list">{today.pending.map(item => <li key={item.kind + item.requestId}>
          <a href={conversationTurnHref(item.conversationId, item.requestId)}>
            <span className="search-field">{pendingLabel[item.kind]}</span>{item.text}</a>
        </li>)}</ul>
      </section>}
      <section className="today-section" aria-labelledby="today-recent">
        <h2 id="today-recent">接着聊</h2>
        {today.recentConversations.length > 0 && <ul className="today-list">{today.recentConversations.map(item =>
          <li key={item.conversationId}><a href={conversationHref(item.conversationId)}>{item.title}</a></li>)}</ul>}
        <a className="button-link" href={conversationHref(newConversationId)}>开始新对话</a>
      </section>
    </>}
  </div>
}
