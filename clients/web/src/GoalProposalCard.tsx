import { createContext, useContext, useState } from 'react'
import type { GoalProgressBlock, GoalProposalBlock } from '../../../src/contracts/conversation'
import type { LearningGoal, LearningGoalCommand } from '../../../src/contracts/learning-goal'

export interface GoalProposals {
  goals: LearningGoal[] | null
  run: (command: LearningGoalCommand) => Promise<string | null>
}

export const GoalProposalsContext = createContext<GoalProposals | null>(null)

// An Agent proposal in a reply. Accepting it creates the goal; every device then shows it as taken.
export function GoalProposalCard({ block, requestId }: { block: GoalProposalBlock & { id: string }; requestId: string }) {
  const proposals = useContext(GoalProposalsContext)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const taken = proposals?.goals?.find(goal => goal.proposalBlockId === block.id)
  const sameTitle = !taken && proposals?.goals?.find(goal => goal.title === block.title)
  const headingId = 'goal-proposal-' + block.id

  async function accept() {
    if (!proposals || busy) return
    setBusy(true)
    setFailure('')
    const problem = await proposals.run({
      operation: 'create', commandId: crypto.randomUUID(), title: block.title, motivation: block.motivation, progress: '',
      status: 'active', proposal: { requestId, blockId: block.id },
    })
    setBusy(false)
    if (problem) setFailure(problem)
  }

  return <section className="goal-proposal" aria-labelledby={headingId}>
    <p className="goal-proposal-label">提议的学习目标</p>
    <h3 id={headingId}>{block.title}</h3>
    {block.motivation && <p>为什么想学：{block.motivation}</p>}
    {taken ? <p className="goal-proposal-state" role="status">已设为学习目标。<a href="#/goals">查看学习目标</a></p>
      : sameTitle ? <p className="goal-proposal-state">已有同名的学习目标。<a href="#/goals">查看学习目标</a></p>
      : <div className="goal-proposal-actions">
        <button type="button" onClick={() => void accept()} disabled={!proposals?.goals || busy} aria-describedby={failure ? headingId + '-error' : undefined}>
          {busy ? '正在保存…' : '设为学习目标'}</button>
        {failure && <p id={headingId + '-error'} role="alert" className="form-error">{failure}</p>}
      </div>}
  </section>
}

// New progress the Agent suggests for the conversation's goal. Keeping it is an ordinary update of the goal; once the
// goal's progress reads the same, every device shows it as kept.
export function GoalProgressCard({ block }: { block: GoalProgressBlock }) {
  const proposals = useContext(GoalProposalsContext)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const goal = proposals?.goals?.find(item => item.id === block.goalId)
  const headingId = 'goal-progress-' + block.id

  async function keep() {
    if (!proposals || !goal || busy) return
    setBusy(true)
    setFailure('')
    const problem = await proposals.run({
      operation: 'update', commandId: crypto.randomUUID(), id: goal.id, expectedRevision: goal.revision,
      title: goal.title, motivation: goal.motivation, progress: block.progress, status: goal.status,
    })
    setBusy(false)
    if (problem) setFailure(problem)
  }

  return <section className="goal-proposal" aria-labelledby={headingId}>
    <p className="goal-proposal-label">提议更新目标进展</p>
    <h3 id={headingId}>{goal?.title ?? '学习目标'}</h3>
    <p>{block.progress}</p>
    {proposals?.goals && !goal ? <p className="goal-proposal-state">这个目标已删除。</p>
      : goal?.progress === block.progress ? <p className="goal-proposal-state" role="status">已更新为目前进展。<a href="#/goals">查看学习目标</a></p>
      : <div className="goal-proposal-actions">
        {goal?.progress && <p className="goal-proposal-state">原来的进展：{goal.progress}</p>}
        <button type="button" onClick={() => void keep()} disabled={!goal || busy} aria-describedby={failure ? headingId + '-error' : undefined}>
          {busy ? '正在保存…' : '更新目前进展'}</button>
        {failure && <p id={headingId + '-error'} role="alert" className="form-error">{failure}</p>}
      </div>}
  </section>
}
