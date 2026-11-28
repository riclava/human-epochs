import { createContext, useContext, useState } from 'react'
import type { GoalProposalBlock } from '../../../src/contracts/conversation'
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
