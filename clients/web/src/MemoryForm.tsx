import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { personalMemoryBodyLimit, personalMemoryKindSchema } from '../../../src/contracts/personal-memory'
import type { PersonalMemory } from '../../../src/contracts/personal-memory'

export const kindLabel = { statement: '本人陈述', inference: 'Agent 推断', wish: '个人愿望' }

export type MemoryDetails = Pick<PersonalMemory, 'kind' | 'body' | 'topic' | 'authorizedForTutoring' | 'expiresAt'>

function localDateTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export function MemoryForm({ initial, authorizationHint, saving, stale, error, onSubmit, onCancel }: {
  initial: Partial<MemoryDetails>
  authorizationHint?: string
  saving: boolean
  stale: boolean
  error: string
  onSubmit: (details: MemoryDetails) => void
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
    onSubmit({
      body, kind: personalMemoryKindSchema.parse(fields.get('kind')), topic: String(fields.get('topic')).trim(),
      authorizedForTutoring: fields.has('authorizedForTutoring'), expiresAt: end ? new Date(end).toISOString() : null,
    })
  }

  return <form className="message-memory-form" onSubmit={submit} aria-busy={saving}>
    <label htmlFor={id + '-body'}>记忆内容</label>
    <textarea id={id + '-body'} ref={bodyField} name="body" rows={3} maxLength={personalMemoryBodyLimit} required readOnly={saving}
      defaultValue={initial.body ?? ''}
      aria-invalid={blank || undefined} aria-describedby={blank ? id + '-blank' : error ? id + '-error' : undefined}
      onChange={() => setBlank(false)} />
    {blank && <p className="form-error" id={id + '-blank'} role="alert">请填写记忆内容。</p>}
    <label className="memory-authorization">
      <input type="checkbox" name="authorizedForTutoring" defaultChecked={initial.authorizedForTutoring ?? false} disabled={saving}
        aria-describedby={authorizationHint ? id + '-authorization' : undefined} />
      允许用于学习辅导
    </label>
    {authorizationHint && <small id={id + '-authorization'}>{authorizationHint}</small>}
    <details className="memory-options">
      <summary>更多选项</summary>
      <label htmlFor={id + '-kind'}>类型</label>
      <select id={id + '-kind'} name="kind" defaultValue={initial.kind ?? 'statement'} disabled={saving}>
        {Object.entries(kindLabel).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select>
      <label htmlFor={id + '-topic'}>适用主题（可选）</label>
      <input id={id + '-topic'} name="topic" maxLength={120} defaultValue={initial.topic} readOnly={saving}
        aria-describedby={id + '-topic-help'} />
      <small id={id + '-topic-help'}>当前问题包含该主题时才会使用。留空可用于所有学习主题。</small>
      <label htmlFor={id + '-expires'}>有效期（可选）</label>
      <input id={id + '-expires'} type="datetime-local" name="expiresAt" defaultValue={localDateTime(initial.expiresAt)} readOnly={saving} />
    </details>
    {error && <p id={id + '-error'} role="alert" className="form-error">{error}</p>}
    <div className="memory-actions">
      <button type="submit" className="primary" disabled={saving || stale}>{saving ? '正在保存…' : '保存记忆'}</button>
      <button type="button" onClick={onCancel} disabled={saving}>取消</button>
    </div>
  </form>
}
