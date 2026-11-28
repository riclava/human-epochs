import { useCallback, useEffect, useState } from 'react'
import type { LearningCommand, LearningRecord, LearningTopic, ReviewResult } from '../../../src/contracts/learning'
import { HttpError, request } from './api'
import { conversationHref } from './routes'
import type { WorkspacePageProps } from './workspace-pages'
import { useLearningGoals } from './learning-goals-client'

const resultLabels: Record<ReviewResult, string> = { recalled: '独立答出', partial: '部分答出', forgotten: '没想起来' }
const day = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

function nextReview(topic: LearningTopic) {
  if (topic.stopped) return '已停止复习这个主题。'
  if (!topic.nextReviewAt) return '暂时没有安排下一次复习。'
  return Date.parse(topic.nextReviewAt) <= Date.now() ? '已到复习时间，回到任意对话就能看到邀请。' : `下次复习：${day(topic.nextReviewAt)}`
}

function TopicCard({ topic, busy, onStop }: { topic: LearningTopic; busy: boolean; onStop: () => void }) {
  const headingId = 'learning-topic-' + topic.originRequestId
  return <li>
    <article className="learning-topic" aria-labelledby={headingId}>
      <h2 id={headingId}>{topic.topic}</h2>
      <p className="learning-topic-source">来自{topic.sourceLabel} · <a href={conversationHref(topic.conversationId)}>
        {topic.conversationTitle ?? '原对话'}</a></p>
      <p className="learning-topic-next">{nextReview(topic)}</p>
      {topic.attempts.length > 0
        ? <ol className="learning-attempts" aria-label="复习结果">
          {topic.attempts.map(attempt => <li key={attempt.answeredAt} data-result={attempt.result}>
            <span><time dateTime={attempt.answeredAt}>{day(attempt.answeredAt)}</time> · <strong>{resultLabels[attempt.result]}</strong></span>
            <span>{attempt.note}</span>
          </li>)}
        </ol>
        : <p className="learning-attempts-empty">还没有作答记录。</p>}
      {!topic.stopped && <button type="button" disabled={busy} onClick={onStop}>不再复习这个主题</button>}
    </article>
  </li>
}

export function LearningRecordView({ userId, onUnauthorized, heading }: WorkspacePageProps) {
  const [record, setRecord] = useState<LearningRecord | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [failure, setFailure] = useState('')
  // '' shows every topic, 'none' those outside any goal, otherwise one goal's topics.
  const [goalFilter, setGoalFilter] = useState('')
  const { goals } = useLearningGoals(userId, onUnauthorized)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await request('/learning-record', { headers: { 'X-User-Id': userId }, signal })
      setRecord(await response.json())
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

  async function run(command: LearningCommand, done: string) {
    setBusy(true)
    setFailure('')
    try {
      const response = await request('/learning-record/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId }, body: JSON.stringify(command),
      })
      setRecord(await response.json())
      setStatus(done)
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) onUnauthorized()
      else if (error instanceof HttpError && error.status === 404) { setFailure('这个主题已不存在。学习记录已刷新。'); void load() }
      else setFailure('暂时无法完成操作。请检查网络后重试。')
    } finally {
      setBusy(false)
    }
  }

  const shown = (record?.topics ?? []).filter(topic => !goalFilter || (goalFilter === 'none' ? !topic.goalId : topic.goalId === goalFilter))
  return <div className="settings-content learning-record">
    <header className="settings-heading">
      <h1 id={heading.id}>{heading.text}</h1>
      <p>Agent 安排过的复习，每次作答的结果，以及下一次什么时候再问。</p>
    </header>
    <p role="status" className="sr-only">{status}</p>
    {failure && <p role="alert" className="form-error">{failure}</p>}
    {loadError && <div className="notice notice-error">
      <p role="alert">暂时无法读取学习记录。请检查网络连接后重试。</p>
      <button type="button" onClick={() => { setLoadError(false); void load() }}>重新读取</button>
    </div>}
    {record && !record.remindersEnabled && <div className="notice learning-reminders-off">
      <p>你已停止所有复习提醒，到期的复习不会出现在对话里。</p>
      <button type="button" disabled={busy} onClick={() => void run({ operation: 'resume_reminders' }, '已重新开启复习提醒。')}>
        重新开启复习提醒</button>
    </div>}
    {record && !record.topics.length && <p className="learning-empty">
      还没有复习记录。讨论课程或你附加的原文后，Agent 会在合适的时候邀请你复习。</p>}
    {record && record.topics.length > 0 && !!goals?.length && <div className="learning-filter">
      <label htmlFor="learning-goal-filter">按学习目标查看</label>
      <select id="learning-goal-filter" value={goalFilter} onChange={event => setGoalFilter(event.target.value)}>
        <option value="">全部主题</option>
        {goals.map(goal => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
        <option value="none">未归入目标</option>
      </select>
    </div>}
    {record && record.topics.length > 0 && !shown.length && <p className="learning-empty">这个目标下还没有复习主题。把相关对话归到这个目标后，它的复习会出现在这里。</p>}
    {record && shown.length > 0 && <ul className="learning-topics">
      {shown.map(topic => <TopicCard key={topic.originRequestId} topic={topic} busy={busy}
        onStop={() => void run({ operation: 'stop_topic', originRequestId: topic.originRequestId }, `已停止复习「${topic.topic}」。`)} />)}
    </ul>}
  </div>
}
