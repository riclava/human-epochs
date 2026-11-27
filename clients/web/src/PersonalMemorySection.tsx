import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { UserConversationTurn } from '../../../src/contracts/conversation'
import { personalMemoryBodyLimit, personalMemoryKindSchema } from '../../../src/contracts/personal-memory'
import type { PersonalMemoryCommand, PersonalMemorySnapshot, PersonalMemory } from '../../../src/contracts/personal-memory'
import { HttpError, request } from './api'

type Unsent<T = PersonalMemoryCommand> = T extends PersonalMemoryCommand ? Omit<T, 'commandId'> : never
type Source = Pick<UserConversationTurn, 'requestId' | 'messageText'>
const kindLabel = { statement: '本人陈述', inference: 'Agent 推断', wish: '个人愿望' }

function localDateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function MemoryForm({ source, record, saving, stale, error, onSubmit, onCancel }: {
  source?: Source
  record?: PersonalMemory
  saving: boolean
  stale: boolean
  error: string
  onSubmit: (command: Unsent) => void
  onCancel: () => void
}) {
  const id = useId()
  const bodyField = useRef<HTMLTextAreaElement>(null)
  const [blank, setBlank] = useState(false)
  useEffect(() => { bodyField.current?.focus() }, [])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving || stale) return
    const fields = new FormData(event.currentTarget)
    const body = String(fields.get('body')).trim()
    if (!body) { setBlank(true); bodyField.current?.focus(); return }
    const end = String(fields.get('expiresAt') ?? '')
    const sourceRequestId = record?.sourceRequestId ?? source?.requestId
    const details = {
      body, kind: personalMemoryKindSchema.parse(fields.get('kind')), topic: String(fields.get('topic')).trim(),
      authorizedForTutoring: fields.has('authorizedForTutoring'), expiresAt: end ? new Date(end).toISOString() : null,
      ...(sourceRequestId ? { sourceRequestId } : {}),
    }
    onSubmit(record ? { operation: 'correct', id: record.id, expectedRevision: record.revision, ...details }
      : { operation: 'remember', ...details })
  }

  return <form className="message-memory-form" onSubmit={submit} aria-busy={saving}>
    <label htmlFor={id + '-body'}>记忆内容</label>
    <textarea id={id + '-body'} ref={bodyField} name="body" rows={3} maxLength={personalMemoryBodyLimit} required readOnly={saving}
      defaultValue={record?.body ?? (source && source.messageText.length <= personalMemoryBodyLimit ? source.messageText : '')}
      aria-invalid={blank || undefined} aria-describedby={blank ? id + '-blank' : error ? id + '-error' : undefined}
      onChange={() => setBlank(false)} />
    {blank && <p className="form-error" id={id + '-blank'} role="alert">请填写记忆内容。</p>}
    <label className="memory-authorization">
      <input type="checkbox" name="authorizedForTutoring" defaultChecked={record?.authorizedForTutoring ?? false} disabled={saving} />
      允许用于学习辅导
    </label>
    <details className="memory-options">
      <summary>更多选项</summary>
      <label htmlFor={id + '-kind'}>类型</label>
      <select id={id + '-kind'} name="kind" defaultValue={record?.kind ?? 'statement'} disabled={saving}>
        {Object.entries(kindLabel).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select>
      <label htmlFor={id + '-topic'}>适用主题（可选）</label>
      <input id={id + '-topic'} name="topic" maxLength={120} defaultValue={record?.topic} readOnly={saving}
        aria-describedby={id + '-topic-help'} />
      <small id={id + '-topic-help'}>当前问题包含该主题时才会使用。留空可用于所有学习主题。</small>
      <label htmlFor={id + '-expires'}>有效期（可选）</label>
      <input id={id + '-expires'} type="datetime-local" name="expiresAt" defaultValue={localDateTime(record?.expiresAt)} readOnly={saving} />
    </details>
    {error && <p id={id + '-error'} role="alert" className="form-error">{error}</p>}
    <div className="memory-actions">
      <button type="submit" className="primary" disabled={saving || stale}>{saving ? '正在保存…' : '保存记忆'}</button>
      <button type="button" onClick={onCancel} disabled={saving}>取消</button>
    </div>
  </form>
}

export function PersonalMemorySection({ userId, memories, source, onSaved, onReload, onUnauthorized }: {
  userId: string
  memories: PersonalMemory[]
  source?: Source
  onSaved: (snapshot: PersonalMemorySnapshot) => void
  onReload: () => void
  onUnauthorized: () => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<PersonalMemory | 'new' | null>(null)
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
      setStatus(command.operation === 'forget' ? '已忘记这条记忆。' : '已保存记忆。')
      toggle.current?.focus()
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

  function reset() {
    dialog.current?.close()
    setEditing(null)
    setError('')
    setStale(false)
    onReload()
    toggle.current?.focus()
  }

  if (!source && !memories.length && !open && !status) return null
  const label = open ? '收起记忆' : !source ? '查看已保存的记忆' : memories.length ? '查看这条消息的记忆' : '记住这条消息'
  return <div className="message-memory">
    <button ref={toggle} type="button" className="memory-toggle" aria-expanded={open} aria-controls={id} aria-disabled={saving || undefined}
      onClick={() => {
        if (saving) return
        setOpen(!open)
        if (!stale) setError('')
        setEditing(!open && !stale && source && !memories.length ? 'new' : null)
      }}>{label}</button>
    <p className="memory-status" role="status">{status}</p>
    <section id={id} className="message-memory-panel" aria-label={source ? '这条消息的记忆' : '已保存的记忆'} hidden={!open}>
      {open && <>
        {memories.length > 0 && <ul className="message-memory-list">{memories.map(record => <li key={record.id}>
          <p>{record.body}</p>
          <small>{kindLabel[record.kind]} · {record.authorizedForTutoring ? '已授权学习辅导' : '仅供回看'}
            {record.topic && <> · {record.topic}</>}
            {record.expiresAt && <> · 有效至 <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString('zh-CN')}</time></>}
          </small>
          <div className="memory-actions">
            <button type="button" disabled={saving || stale} onClick={() => { setError(''); setEditing(record) }}>纠正</button>
            <button type="button" disabled={saving || stale} onClick={() => {
              setForgetting(record); setError(''); dialog.current?.showModal()
            }}>忘记</button>
          </div>
        </li>)}</ul>}
        {editing ? <MemoryForm key={editing === 'new' ? 'new' : editing.id} source={source}
          record={editing === 'new' ? undefined : editing} saving={saving} stale={stale} error={forgetting ? '' : error}
          onSubmit={command => void change(command)} onCancel={() => { setEditing(null); setError(''); toggle.current?.focus() }} />
          : source && <button type="button" disabled={saving || stale} onClick={() => setEditing('new')}>从这条消息记住信息</button>}
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
