import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  activeLearningGoalLimit, goalNoteLimit, goalTitleLimit, type LearningGoal, type LearningGoalCommand,
} from '../../../src/contracts/learning-goal'
import { useLearningGoals } from './learning-goals-client'
import type { WorkspacePageProps } from './workspace-pages'

type Status = LearningGoal['status']
type Fields = Pick<LearningGoal, 'title' | 'motivation' | 'progress'>

const groups: { status: Status; title: string; empty?: string }[] = [
  { status: 'active', title: '进行中', empty: '还没有进行中的目标。' },
  { status: 'paused', title: '已暂停' },
  { status: 'done', title: '已完成' },
]
const statusActions: Record<Status, { status: Status; label: string }[]> = {
  active: [{ status: 'done', label: '标记完成' }, { status: 'paused', label: '暂停' }],
  paused: [{ status: 'active', label: '继续' }, { status: 'done', label: '标记完成' }],
  done: [{ status: 'active', label: '重新开始' }],
}

const read = (event: FormEvent<HTMLFormElement>): Fields => {
  const form = new FormData(event.currentTarget)
  const text = (name: string) => String(form.get(name) ?? '').trim()
  return { title: text('title'), motivation: text('motivation'), progress: text('progress') }
}

// The title, why and progress fields, shared by adding and editing a goal.
function GoalFields({ prefix, goal, error }: { prefix: string; goal?: Fields; error?: string }) {
  const errorId = error ? prefix + '-error' : undefined
  return <>
    <label htmlFor={prefix + '-title'}>想学会什么</label>
    <input id={prefix + '-title'} name="title" required maxLength={goalTitleLimit} defaultValue={goal?.title}
      placeholder="例如：看懂天气图" aria-invalid={!!error || undefined} aria-describedby={errorId} />
    <label htmlFor={prefix + '-motivation'}>为什么想学（可选）</label>
    <textarea id={prefix + '-motivation'} name="motivation" rows={2} maxLength={goalNoteLimit} defaultValue={goal?.motivation} />
    <label htmlFor={prefix + '-progress'}>目前学到哪里（可选）</label>
    <textarea id={prefix + '-progress'} name="progress" rows={2} maxLength={goalNoteLimit} defaultValue={goal?.progress} />
    {error && <p id={errorId} role="alert" className="form-error">{error}</p>}
  </>
}

function GoalItem({ goal, busy, run, onDelete, onMoved }: {
  goal: LearningGoal; busy: boolean; run: (command: LearningGoalCommand) => Promise<string | null>; onDelete: (goal: LearningGoal) => void
  // A status change moves the goal to another group, so focus goes somewhere that stays.
  onMoved: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const editButton = useRef<HTMLButtonElement>(null)
  const update = (fields: Fields, status: Status) =>
    run({ operation: 'update', commandId: crypto.randomUUID(), id: goal.id, expectedRevision: goal.revision,
      title: fields.title, motivation: fields.motivation, progress: fields.progress, status })

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const problem = await update(read(event), goal.status)
    setError(problem ?? '')
    if (!problem) {
      setEditing(false)
      requestAnimationFrame(() => editButton.current?.focus())
    }
  }

  const prefix = 'goal-' + goal.id
  if (editing) return <li className="goal-item">
    <form className="goal-form" onSubmit={event => void save(event)} aria-label={`修改目标 ${goal.title}`}>
      <GoalFields prefix={prefix} goal={goal} error={error} />
      <div className="goal-actions">
        <button type="submit" className="primary" disabled={busy}>保存</button>
        <button type="button" disabled={busy} onClick={() => { setEditing(false); setError('') }}>取消</button>
      </div>
    </form>
  </li>
  return <li className="goal-item">
    <h3>{goal.title}</h3>
    {goal.motivation && <p><span className="goal-field">为什么想学</span>{goal.motivation}</p>}
    {goal.progress && <p><span className="goal-field">目前进展</span>{goal.progress}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="goal-actions">
      {statusActions[goal.status].map(action => <button key={action.status} type="button" disabled={busy}
        onClick={() => void update(goal, action.status).then(problem => {
          setError(problem ?? '')
          if (!problem) onMoved(`「${goal.title}」已${action.label === '标记完成' ? '完成' : action.label === '暂停' ? '暂停' : '移到进行中'}。`)
        })}
        aria-label={`${action.label}：${goal.title}`}>{action.label}</button>)}
      <button ref={editButton} type="button" disabled={busy} onClick={() => setEditing(true)} aria-label={`修改：${goal.title}`}>修改</button>
      <button type="button" disabled={busy} onClick={() => onDelete(goal)} aria-label={`删除：${goal.title}`}>删除</button>
    </div>
  </li>
}

export function LearningGoalsView({ userId, onUnauthorized, heading }: WorkspacePageProps) {
  const { goals, loadError, reload, run } = useLearningGoals(userId, onUnauthorized)
  const [busy, setBusy] = useState(false)
  const [addError, setAddError] = useState('')
  const [deleting, setDeleting] = useState<LearningGoal | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (deleting) dialog.current?.showModal() }, [deleting])

  const guarded = async (command: LearningGoalCommand) => {
    setBusy(true)
    try {
      return await run(command)
    } finally {
      setBusy(false)
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const problem = await guarded({ operation: 'create', commandId: crypto.randomUUID(), ...read(event), status: 'active' })
    setAddError(problem ?? '')
    if (!problem) form.reset()
  }

  async function remove() {
    if (!deleting) return
    const problem = await guarded({ operation: 'delete', commandId: crypto.randomUUID(), id: deleting.id, expectedRevision: deleting.revision })
    setDeleteError(problem ?? '')
    if (problem) return
    setAnnouncement(`已删除「${deleting.title}」。`)
    dialog.current?.close()
    headingRef.current?.focus()
  }

  function moved(message: string) {
    setAnnouncement(message)
    headingRef.current?.focus()
  }

  const active = goals?.filter(goal => goal.status === 'active').length ?? 0
  return <div className="settings-content goals-page">
    <header className="settings-heading">
      <h1 id={heading.id} ref={headingRef} tabIndex={-1}>{heading.text}</h1>
      <p>写下想长期学会的事。使用在线模型时，进行中的目标会作为背景交给 Agent，讲解和建议会联系到这些目标；暂停或完成后不再提供。</p>
    </header>
    <p role="status" className="sr-only">{announcement}</p>
    {loadError && <div className="notice notice-error">
      <p role="alert">暂时无法读取学习目标。请检查网络连接后重试。</p>
      <button type="button" onClick={() => void reload()}>重新读取</button>
    </div>}
    {goals && <>
      {groups.map(group => {
        const items = goals.filter(goal => goal.status === group.status)
        if (!items.length && !group.empty) return null
        return <section key={group.status} className="goal-group" aria-labelledby={'goals-' + group.status}>
          <h2 id={'goals-' + group.status}>{group.title}{group.status === 'active' && `（${active}/${activeLearningGoalLimit}）`}</h2>
          {items.length ? <ul className="goal-list">{items.map(goal =>
            <GoalItem key={goal.id} goal={goal} busy={busy} run={guarded} onMoved={moved}
              onDelete={target => { setDeleteError(''); setDeleting(target) }} />)}</ul>
            : <p className="learning-empty">{group.empty}</p>}
        </section>
      })}
      <section className="goal-group" aria-labelledby="goal-add-title">
        <h2 id="goal-add-title">添加目标</h2>
        <form className="goal-form" onSubmit={event => void add(event)}>
          <GoalFields prefix="goal-new" error={addError} />
          <div className="goal-actions"><button type="submit" className="primary" disabled={busy}>添加目标</button></div>
        </form>
      </section>
    </>}
    <dialog ref={dialog} className="memory-dialog" aria-labelledby="goal-delete-title"
      onCancel={event => { if (busy) event.preventDefault() }} onClose={() => setDeleting(null)}>
      <h2 id="goal-delete-title">删除这个目标？</h2>
      {deleting && <p>「{deleting.title}」和它的说明会被删除，Agent 之后不会再参考它。对话内容不受影响。</p>}
      {deleteError && <p role="alert" className="form-error">{deleteError}</p>}
      <div className="memory-actions">
        <button type="button" autoFocus disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '删除目标'}</button>
      </div>
    </dialog>
  </div>
}
