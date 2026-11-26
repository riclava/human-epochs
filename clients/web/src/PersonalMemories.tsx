import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { memoryBodyLimit, memoryKindSchema } from '../../../src/contracts/memory'
import type { MemoryCommand, MemorySnapshot, PersonalMemory } from '../../../src/contracts/memory'
import { HttpError, request } from './api'

const kindLabel = { statement: '本人陈述', inference: 'Agent 推断', wish: '个人愿望' }
type Unsent<T = MemoryCommand> = T extends MemoryCommand ? Omit<T, 'commandId'> : never

function localDateTime(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function memoryFields(form: HTMLFormElement) {
  const fields = new FormData(form)
  const end = String(fields.get('expiresAt') ?? '')
  return {
    body: String(fields.get('body')).trim(),
    kind: memoryKindSchema.parse(fields.get('kind')),
    topic: String(fields.get('topic')).trim(),
    authorized: fields.has('authorized'),
    expiresAt: end ? new Date(end).toISOString() : null,
  }
}

export function PersonalMemories({ learnerId, sourceId, onUnauthorized }: {
  learnerId: string
  sourceId: string | null
  onUnauthorized: () => void
}) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot>()
  const [source, setSource] = useState('')
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<PersonalMemory>()
  const [forgetting, setForgetting] = useState<PersonalMemory>()
  const [saving, setSaving] = useState(false)
  const [formRevision, setFormRevision] = useState(0)
  const send = useRef<{ key: string; id: string; controller: AbortController } | undefined>(undefined)
  const formHeading = useRef<HTMLHeadingElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    const options = { signal: controller.signal, headers: { 'X-Learner-Id': learnerId } }
    async function load() {
      try {
        const [current, origin] = await Promise.all([
          request('/memories', options).then(response => response.json() as Promise<MemorySnapshot>),
          sourceId ? request('/memories/source/' + encodeURIComponent(sourceId), options).then(response => response.json() as Promise<{ text: string }>) : null,
        ])
        if (controller.signal.aborted) return
        setSnapshot(current)
        setSource(origin?.text ?? '')
        setLoadError('')
      } catch (failure) {
        if (controller.signal.aborted) return
        if (failure instanceof HttpError && failure.status === 401) onUnauthorized()
        else setLoadError('暂时无法读取个人记忆或来源。请重新读取。')
      }
    }
    void load()
    return () => controller.abort()
  }, [attempt, learnerId, sourceId, onUnauthorized])

  useEffect(() => () => send.current?.controller.abort(), [])

  async function change(command: Unsent) {
    const key = JSON.stringify(command)
    const commandId = send.current?.key === key ? send.current.id : crypto.randomUUID()
    const controller = new AbortController()
    send.current = { key, id: commandId, controller }
    setSaving(true)
    setError('')
    setStatus('')
    try {
      const response = await request('/memories', {
        method: 'POST',
        headers: { 'X-Learner-Id': learnerId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...command, commandId }), signal: controller.signal,
      })
      const data: MemorySnapshot = await response.json()
      if (controller.signal.aborted) return
      setSnapshot(data)
      setEditing(undefined)
      dialog.current?.close()
      setFormRevision(value => value + 1)
      setStatus(command.operation === 'forget' ? '已忘记这条记忆。' : '个人记忆已保存。')
      send.current = undefined
      requestAnimationFrame(() => formHeading.current?.focus())
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof HttpError && failure.status === 401) onUnauthorized()
      else if (failure instanceof HttpError && failure.status < 500) {
        const detail = await failure.response?.json().catch(() => null)
        if (!controller.signal.aborted) setError(detail?.message ?? '请核对内容后重试。')
      } else setError('暂时无法确认保存结果。请重试。')
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const fields = memoryFields(event.currentTarget)
    if (!fields.body) {
      setError('请填写记忆内容。')
      event.currentTarget.querySelector('textarea')?.focus()
      return
    }
    const sourceRequestId = editing ? editing.sourceRequestId : sourceId
    const details = { ...fields, ...(sourceRequestId ? { sourceRequestId } : {}) }
    void change(editing ? { operation: 'correct', id: editing.id, revision: editing.revision, ...details }
      : { operation: 'remember', ...details })
  }

  function reload() {
    setEditing(undefined)
    setError('')
    setAttempt(value => value + 1)
  }

  return <div className="settings-content memory-content">
    <header className="settings-heading">
      <h1 id="memory-heading">个人记忆</h1>
      <p>在线学习 Agent 可以参考你授权的记忆。你可以纠正内容、撤回授权或忘记某条记忆。</p>
    </header>
    {loadError ? <div className="notice notice-error">
      <p role="alert">{loadError}</p><button type="button" onClick={reload}>重新读取</button>
      {sourceId && <a href="#/memory">回到个人记忆</a>}
    </div> : snapshot ? <>
      <form className="settings-form settings-assistant-form memory-form" key={editing?.id ?? formRevision} onSubmit={submit} aria-busy={saving}>
        <h2 ref={formHeading} tabIndex={-1}>{editing ? '纠正记忆' : '添加记忆'}</h2>
        {source && !editing && <blockquote className="source-quote">{source}</blockquote>}
        <label htmlFor="memory-body">记忆内容</label>
        <textarea id="memory-body" name="body" maxLength={memoryBodyLimit} required rows={3}
          defaultValue={editing?.body ?? (source.length <= memoryBodyLimit ? source : '')}
          aria-describedby={error && !forgetting ? 'memory-form-error' : 'memory-body-help'} readOnly={saving} />
        <small id="memory-body-help">最多 {memoryBodyLimit} 字。你可以从来源消息中摘出要保留的内容。</small>
        <div className="settings-model-fields">
          <div><label htmlFor="memory-kind">类型</label>
            <select name="kind" id="memory-kind" defaultValue={editing?.kind ?? 'statement'}>
              {Object.entries(kindLabel).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
            </select></div>
          <div><label htmlFor="memory-topic">适用主题（可选）</label>
            <input id="memory-topic" name="topic" maxLength={120} defaultValue={editing?.topic}
              aria-describedby="memory-topic-help" />
            <small id="memory-topic-help">当前问题包含此主题时才使用。留空可用于所有学习主题。</small></div>
          <div><label htmlFor="memory-expires">有效期（可选）</label>
            <input id="memory-expires" name="expiresAt" type="datetime-local" defaultValue={localDateTime(editing?.expiresAt)} /></div>
        </div>
        <label className="memory-authorization">
          <input type="checkbox" name="authorized" defaultChecked={editing?.authorized ?? false} />
          允许用于学习辅导
        </label>
        {error && !forgetting && <div className="notice notice-error">
          <p id="memory-form-error" role="alert">{error}</p><button type="button" onClick={reload}>重新读取</button>
        </div>}
        <div className="settings-assistant-actions">
          {editing && <button type="button" disabled={saving} onClick={() => { setEditing(undefined); setError('') }}>取消纠正</button>}
          <button type="submit" disabled={saving}>{saving ? '正在保存…' : '保存记忆'}</button>
        </div>
      </form>
      <p role="status">{status}</p>
      <section className="memory-list" aria-labelledby="memory-list-heading">
        <h2 id="memory-list-heading">已保存的记忆</h2>
        {snapshot.memories.length ? <ul>{snapshot.memories.map(record => <li key={record.id}>
          <p>{record.body}</p>
          <small>{kindLabel[record.kind]} · {record.authorized ? '已授权学习辅导' : '仅供回看'}
            {record.topic && <> · {record.topic}</>}
            {record.expiresAt && <> · 有效至 <time dateTime={record.expiresAt}>{new Date(record.expiresAt).toLocaleString('zh-CN')}</time></>}
          </small>
          <div className="settings-assistant-actions">
            {record.sourceRequestId && <a href={'#/memory?source=' + record.sourceRequestId}>查看来源消息</a>}
            <button type="button" disabled={saving} onClick={() => {
              setEditing(record); setError(''); requestAnimationFrame(() => formHeading.current?.focus())
            }}>纠正</button>
            <button type="button" disabled={saving} onClick={() => {
              setError(''); setForgetting(record); dialog.current?.showModal()
            }}>忘记</button>
          </div>
        </li>)}</ul> : <p>还没有个人记忆。你可以在上方保存一条学习目标或偏好。</p>}
      </section>
    </> : <p role="status">正在读取个人记忆…</p>}
    <dialog ref={dialog} className="memory-dialog" aria-labelledby="memory-forget-title"
      onCancel={event => { if (saving) event.preventDefault() }} onClose={() => { setForgetting(undefined); setError('') }}>
      <h2 id="memory-forget-title">忘记这条记忆？</h2>
      <p>这条记忆和使用它生成的回复内容将被清除。</p>
      {forgetting && <blockquote className="source-quote">{forgetting.body}</blockquote>}
      {error && forgetting && <p role="alert" className="form-error">{error}</p>}
      <div className="settings-assistant-actions">
        <button type="button" autoFocus disabled={saving} onClick={() => dialog.current?.close()}>取消</button>
        <button type="button" disabled={saving} onClick={() => {
          if (forgetting) void change({ operation: 'forget', id: forgetting.id, revision: forgetting.revision })
        }}>{saving ? '正在忘记…' : '忘记记忆'}</button>
      </div>
    </dialog>
  </div>
}
