import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { conversationTitleLimit } from '../../../src/contracts/conversation'
import type { ConversationList, ConversationListItem } from '../../../src/contracts/conversation'
import { HttpError, request } from './api'
import { conversationHref } from './workspace-pages'

type Unsent = { operation: 'rename'; title: string } | { operation: 'delete' }
type Pending = { key: string; commandId: string }

const failures = {
  missing: '这个对话已不存在。列表已更新。',
  network: '暂时无法完成操作。请检查网络后重试。',
}

export function ConversationListPanel({ userId, items, loaded, error, currentId, onReplace, onRefresh, onNavigate, onStart, onUnauthorized }: {
  userId: string
  items: ConversationListItem[]
  loaded: boolean
  error: boolean
  currentId: string | null
  onReplace: (list: ConversationList) => void
  onRefresh: () => void
  onNavigate: (event: MouseEvent<HTMLAnchorElement>) => void
  onStart: () => void
  onUnauthorized: () => void
}) {
  const id = useId()
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<ConversationListItem | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')
  const [status, setStatus] = useState('')
  const pending = useRef<Pending | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const toggles = useRef(new Map<string, HTMLButtonElement>())
  const startButton = useRef<HTMLButtonElement>(null)
  const removed = useRef(false)

  useEffect(() => { if (deleting) dialog.current?.showModal() }, [deleting])
  // The actions button replaces the rename form only after a render, so focus returns to it here.
  const focusAfterRename = useRef<string | null>(null)
  useEffect(() => {
    if (renaming || !focusAfterRename.current) return
    toggles.current.get(focusAfterRename.current)?.focus()
    focusAfterRename.current = null
  }, [renaming])

  // A retried command reuses its ID, so a lost response cannot rename or delete twice.
  async function run(conversationId: string, command: Unsent) {
    if (saving) return false
    const key = JSON.stringify([conversationId, command])
    const commandId = pending.current?.key === key ? pending.current.commandId : crypto.randomUUID()
    pending.current = { key, commandId }
    setSaving(true)
    setFailure('')
    try {
      const response = await request(`/conversations/${conversationId}/commands`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({ ...command, commandId }),
      })
      pending.current = null
      onReplace(await response.json())
      return true
    } catch (cause) {
      if (cause instanceof HttpError && cause.status === 401) onUnauthorized()
      else if (cause instanceof HttpError && (cause.status === 404 || cause.status === 409)) {
        pending.current = null
        setFailure(failures.missing)
        onRefresh()
      } else setFailure(failures.network)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function rename(event: FormEvent<HTMLFormElement>, item: ConversationListItem) {
    event.preventDefault()
    const title = String(new FormData(event.currentTarget).get('title')).trim()
    if (!title || title === item.title) { setRenaming(null); return }
    if (await run(item.conversationId, { operation: 'rename', title })) {
      setRenaming(null)
      setActionsFor(null)
      setStatus('已重命名对话。')
      focusAfterRename.current = item.conversationId
    }
  }

  async function remove() {
    if (!deleting) return
    const target = deleting
    if (!await run(target.conversationId, { operation: 'delete' })) return
    removed.current = true
    dialog.current?.close()
    setActionsFor(null)
    setStatus('已删除对话。')
    // Leaving a deleted conversation opens the most recent remaining one.
    if (target.conversationId === currentId) window.location.hash = '#/'
  }

  return <section className="conversation-list" aria-labelledby={id + '-heading'}>
    <div className="conversation-list-header">
      <h2 id={id + '-heading'}>最近的对话</h2>
      <button ref={startButton} type="button" className="new-conversation" onClick={onStart}>新对话</button>
    </div>
    <p className="sr-only" role="status">{status}</p>
    {failure && !deleting && <p className="form-error conversation-list-failure" role="alert">{failure}</p>}
    {error && <div className="conversation-list-error">
      <p role="alert">暂时无法读取对话列表。</p>
      <button type="button" onClick={onRefresh}>重新读取</button>
    </div>}
    {loaded && !error && !items.length && <p className="conversation-list-empty">发出第一条消息后，对话会出现在这里。</p>}
    {items.length > 0 && <ul>
      {items.map(item => <li key={item.conversationId}>
        {renaming === item.conversationId
          ? <form className="conversation-rename" onSubmit={event => void rename(event, item)} aria-busy={saving}>
            <label className="sr-only" htmlFor={id + '-title-' + item.conversationId}>对话标题</label>
            <input id={id + '-title-' + item.conversationId} name="title" defaultValue={item.title} maxLength={conversationTitleLimit}
              required autoFocus readOnly={saving} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); focusAfterRename.current = item.conversationId; setRenaming(null) } }} />
            <button type="submit" className="primary" disabled={saving}>{saving ? '正在保存…' : '保存'}</button>
            <button type="button" disabled={saving} onClick={() => { focusAfterRename.current = item.conversationId; setRenaming(null) }}>取消</button>
          </form>
          : <div className="conversation-item">
            <a href={conversationHref(item.conversationId)} onClick={onNavigate}
              aria-current={item.conversationId === currentId ? 'page' : undefined}>{item.title}</a>
            <button type="button" className="conversation-actions-toggle" aria-label={item.title + ' 的操作'}
              aria-expanded={actionsFor === item.conversationId} aria-controls={id + '-actions-' + item.conversationId}
              ref={element => { if (element) toggles.current.set(item.conversationId, element); else toggles.current.delete(item.conversationId) }}
              onClick={() => setActionsFor(value => value === item.conversationId ? null : item.conversationId)}>
              <span aria-hidden="true">⋯</span>
            </button>
          </div>}
        <div className="conversation-actions" id={id + '-actions-' + item.conversationId}
          hidden={actionsFor !== item.conversationId || renaming === item.conversationId}>
          <button type="button" onClick={() => { setFailure(''); setRenaming(item.conversationId) }}>重命名</button>
          <button type="button" onClick={() => { setFailure(''); setDeleting(item) }}>删除</button>
        </div>
      </li>)}
    </ul>}
    <dialog ref={dialog} className="memory-dialog" aria-labelledby={id + '-delete'}
      onCancel={event => { if (saving) event.preventDefault() }}
      onClose={() => {
        const target = deleting
        setDeleting(null)
        setFailure('')
        // The deleted item and its button are gone, so focus moves to starting a new conversation.
        if (removed.current) startButton.current?.focus()
        else if (target) toggles.current.get(target.conversationId)?.focus()
        removed.current = false
      }}>
      <h2 id={id + '-delete'}>删除这个对话？</h2>
      <p>对话里的消息和回复会被删除，无法恢复。从这个对话保存的记忆会保留。</p>
      {deleting && <blockquote className="source-quote">{deleting.title}</blockquote>}
      {failure && <p role="alert" className="form-error">{failure}</p>}
      <div className="memory-actions">
        <button type="button" autoFocus disabled={saving} onClick={() => dialog.current?.close()}>取消</button>
        <button type="button" className="danger" disabled={saving} onClick={() => void remove()}>{saving ? '正在删除…' : '删除对话'}</button>
      </div>
    </dialog>
  </section>
}
