import { useEffect, useId, useRef, useState } from 'react'
import type { UserConversationTurn } from '../../../src/contracts/conversation'
import { personalMemoryBodyLimit } from '../../../src/contracts/personal-memory'
import type { PersonalMemoryCandidate, PersonalMemoryCommand, PersonalMemorySnapshot, PersonalMemory } from '../../../src/contracts/personal-memory'
import { HttpError, request } from './api'
import { kindLabel, MemoryForm, type MemoryDetails } from './MemoryForm'

type Unsent<T = PersonalMemoryCommand> = T extends PersonalMemoryCommand ? Omit<T, 'commandId'> : never
type Source = Pick<UserConversationTurn, 'requestId' | 'messageText'>
type Editing =
  | { kind: 'new' }
  | { kind: 'record'; record: PersonalMemory }
  | { kind: 'candidate'; candidate: PersonalMemoryCandidate }

const savedStatus: Record<Unsent['operation'], string> = {
  remember: '已保存记忆。', correct: '已保存记忆。', accept_candidate: '已保存记忆。',
  forget: '已忘记这条记忆。', reject_candidate: '不会再提议这条内容。', set_suggestions: '',
}

function editingKey(editing: Editing) {
  return editing.kind === 'new' ? 'new' : editing.kind === 'record' ? editing.record.id : editing.candidate.id
}

function SuggestionSetting({ enabled, saving, onChange }: { enabled: boolean; saving: boolean; onChange: (enabled: boolean) => void }) {
  const id = useId()
  // Show the choice while it is being saved. A failed save clears it and the saved setting shows again.
  const [requested, setRequested] = useState<boolean | null>(null)
  useEffect(() => { if (!saving) setRequested(null) }, [saving])
  return <div className="memory-suggestions">
    <label className="memory-authorization">
      <input type="checkbox" checked={requested ?? enabled} disabled={saving} aria-describedby={id}
        onChange={event => { setRequested(event.target.checked); onChange(event.target.checked) }} />
      让 Agent 从我的消息中提议记忆
    </label>
    <small id={id}>提议需要你确认后才会保存。关闭后，还没处理的提议会被清除。</small>
  </div>
}

export function PersonalMemorySection({ userId, memories, candidates = [], suggestionsEnabled, source, onSaved, onReload, onUnauthorized }: {
  userId: string
  memories: PersonalMemory[]
  candidates?: PersonalMemoryCandidate[]
  // Only the conversation-level section manages the suggestion setting.
  suggestionsEnabled?: boolean
  source?: Source
  onSaved: (snapshot: PersonalMemorySnapshot) => void
  onReload: () => void
  onUnauthorized: () => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [forgetting, setForgetting] = useState<PersonalMemory | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [stale, setStale] = useState(false)
  const [status, setStatus] = useState('')
  const pending = useRef<{ key: string; id: string; controller: AbortController } | null>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => () => pending.current?.controller.abort(), [])

  async function change(command: Unsent) {
    if (saving || stale) return
    const key = JSON.stringify(command)
    const commandId = pending.current?.key === key ? pending.current.id : crypto.randomUUID()
    const controller = new AbortController()
    pending.current = { key, id: commandId, controller }
    setSaving(true)
    setError('')
    setStatus('')
    try {
      const response = await request('/personal-memories', {
        method: 'POST', headers: { 'X-User-Id': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...command, commandId }), signal: controller.signal,
      })
      const snapshot: PersonalMemorySnapshot = await response.json()
      if (controller.signal.aborted) return
      pending.current = null
      setEditing(null)
      dialog.current?.close()
      onSaved(snapshot)
      setStatus(command.operation === 'set_suggestions'
        ? command.enabled ? '已开启记忆提议。' : '已关闭记忆提议。' : savedStatus[command.operation])
      if (command.operation !== 'set_suggestions') toggle.current?.focus()
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof HttpError && failure.status === 401) onUnauthorized()
      else if (failure instanceof HttpError && (failure.status === 409 || failure.status === 404)) {
        setStale(true)
        setError('这条记忆已更新。请重新读取后再操作。')
      } else setError('暂时无法完成操作。请核对内容和网络后重试。')
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  function submit(target: Editing, details: MemoryDetails) {
    if (target.kind === 'candidate') {
      void change({ operation: 'accept_candidate', candidateId: target.candidate.id, ...details })
      return
    }
    const sourceRequestId = target.kind === 'record' ? target.record.sourceRequestId : source?.requestId
    const withSource = { ...details, ...(sourceRequestId ? { sourceRequestId } : {}) }
    void change(target.kind === 'record'
      ? { operation: 'correct', id: target.record.id, expectedRevision: target.record.revision, ...withSource }
      : { operation: 'remember', ...withSource })
  }

  function initialDetails(target: Editing): Partial<MemoryDetails> {
    if (target.kind === 'record') return target.record
    if (target.kind === 'candidate') {
      const { kind, body, topic } = target.candidate
      return { kind, body, topic }
    }
    return { body: source && source.messageText.length <= personalMemoryBodyLimit ? source.messageText : '' }
  }

  function reset() {
    dialog.current?.close()
    setEditing(null)
    setError('')
    setStale(false)
    onReload()
    toggle.current?.focus()
  }

  const managesSuggestions = suggestionsEnabled !== undefined
  if (!source && !managesSuggestions && !memories.length && !open && !status) return null
  const label = open ? '收起记忆'
    : !source ? memories.length ? '查看已保存的记忆' : '记忆设置'
      : memories.length ? '查看这条消息的记忆'
        : candidates.length ? `查看记忆提议（${candidates.length}）` : '记住这条消息'
  return <div className="message-memory">
    <button ref={toggle} type="button" className="memory-toggle" aria-expanded={open} aria-controls={id} aria-disabled={saving || undefined}
      onClick={() => {
        if (saving) return
        setOpen(!open)
        if (!stale) setError('')
        setEditing(!open && !stale && source && !memories.length && !candidates.length ? { kind: 'new' } : null)
      }}>{label}</button>
    <p className="memory-status" role="status">{status}</p>
    <section id={id} className="message-memory-panel" aria-label={source ? '这条消息的记忆' : '已保存的记忆'} hidden={!open}>
      {open && <>
        {suggestionsEnabled !== undefined && <SuggestionSetting enabled={suggestionsEnabled} saving={saving || stale}
          onChange={enabled => void change({ operation: 'set_suggestions', enabled })} />}
        {memories.length > 0 && <ul className="message-memory-list">{memories.map(record => <li key={record.id}>
          <p>{record.body}</p>
          <small>{kindLabel[record.kind]} · {record.authorizedForTutoring ? '已授权学习辅导' : '仅供回看'}
            {record.topic && <> · {record.topic}</>}
            {record.expiresAt && <> · 有效至 <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString('zh-CN')}</time></>}
          </small>
          <div className="memory-actions">
            <button type="button" disabled={saving || stale} onClick={() => { setError(''); setEditing({ kind: 'record', record }) }}>纠正</button>
            <button type="button" disabled={saving || stale} onClick={() => {
              setForgetting(record); setError(''); dialog.current?.showModal()
            }}>忘记</button>
          </div>
        </li>)}</ul>}
        {candidates.length > 0 && <ul className="message-memory-list memory-candidates" aria-label="Agent 的记忆提议">
          {candidates.map(candidate => <li key={candidate.id}>
            <p>{candidate.body}</p>
            <small>Agent 提议 · {kindLabel[candidate.kind]}{candidate.topic && <> · {candidate.topic}</>}</small>
            <small>{candidate.reason}</small>
            <blockquote className="source-quote">{candidate.quote}</blockquote>
            <div className="memory-actions">
              <button type="button" disabled={saving || stale} onClick={() => { setError(''); setEditing({ kind: 'candidate', candidate }) }}>
                确认记住
              </button>
              <button type="button" disabled={saving || stale}
                onClick={() => void change({ operation: 'reject_candidate', candidateId: candidate.id })}>不用记</button>
            </div>
          </li>)}
        </ul>}
        {editing ? <MemoryForm key={editingKey(editing)} initial={initialDetails(editing)}
          authorizationHint={editing.kind === 'candidate' && editing.candidate.suggestedForTutoring ? 'Agent 建议用于学习辅导，由你决定是否授权。' : undefined}
          saving={saving} stale={stale} error={forgetting ? '' : error}
          onSubmit={details => submit(editing, details)} onCancel={() => { setEditing(null); setError(''); toggle.current?.focus() }} />
          : source && <button type="button" disabled={saving || stale} onClick={() => setEditing({ kind: 'new' })}>从这条消息记住信息</button>}
        {!editing && error && !forgetting && <p role="alert" className="form-error">{error}</p>}
        {stale && !forgetting && <button type="button" onClick={reset}>重新读取对话</button>}
        <dialog ref={dialog} className="memory-dialog" aria-labelledby={id + '-forget'}
          onCancel={event => { if (saving) event.preventDefault() }} onClose={() => { setForgetting(null); setError('') }}>
          <h2 id={id + '-forget'}>忘记这条记忆？</h2>
          <p>这条记忆和使用它生成的回复内容将被清除。</p>
          {forgetting && <blockquote className="source-quote">{forgetting.body}</blockquote>}
          {error && <p role="alert" className="form-error">{error}</p>}
          <div className="memory-actions">
            <button type="button" autoFocus disabled={saving} onClick={() => dialog.current?.close()}>取消</button>
            {stale ? <button type="button" onClick={reset}>重新读取对话</button>
              : <button type="button" disabled={saving} onClick={() => {
                if (forgetting) void change({ operation: 'forget', id: forgetting.id, expectedRevision: forgetting.revision })
              }}>{saving ? '正在忘记…' : '忘记记忆'}</button>}
          </div>
        </dialog>
      </>}
    </section>
  </div>
}
