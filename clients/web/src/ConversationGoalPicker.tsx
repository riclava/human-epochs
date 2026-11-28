import { useContext, useId, useState } from 'react'
import { HttpError, request } from './api'
import { GoalProposalsContext } from './GoalProposalCard'

const statusSuffix = { active: '', paused: '（已暂停）', done: '（已完成）' }

// Puts the conversation under one of the user's goals. Shown once the conversation exists.
export function ConversationGoalPicker({ userId, conversationId, goalId, onChanged, onUnauthorized }: {
  userId: string; conversationId: string; goalId: string | null; onChanged: () => void; onUnauthorized: () => void
}) {
  const proposals = useContext(GoalProposalsContext)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const id = useId()
  const goals = proposals?.goals
  if (!goals?.length && !goalId) return null

  async function choose(next: string) {
    setBusy(true)
    setFailure('')
    try {
      await request(`/conversations/${conversationId}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({ operation: 'set_goal', commandId: crypto.randomUUID(), goalId: next || null }),
      })
      onChanged()
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) onUnauthorized()
      else setFailure('没有保存。请刷新后重试。')
    } finally {
      setBusy(false)
    }
  }

  return <div className="conversation-goal">
    <label htmlFor={id}>学习目标</label>
    <select id={id} value={goalId ?? ''} disabled={busy || !goals} onChange={event => void choose(event.target.value)}
      aria-describedby={failure ? id + '-error' : undefined}>
      <option value="">不归入目标</option>
      {goals?.map(goal => <option key={goal.id} value={goal.id}>{goal.title}{statusSuffix[goal.status]}</option>)}
    </select>
    {failure && <span id={id + '-error'} role="alert" className="form-error">{failure}</span>}
  </div>
}
