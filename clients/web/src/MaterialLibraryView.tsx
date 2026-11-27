import { useCallback, useEffect, useRef, useState } from 'react'
import type { MaterialItem, MaterialLibrary } from '../../../src/contracts/material'
import { HttpError, request } from './api'
import type { WorkspacePageProps } from './workspace-pages'

const count = (value: number) => value.toLocaleString('zh-CN')
const day = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

export function MaterialLibraryView({ userId, onUnauthorized, heading }: WorkspacePageProps) {
  const [library, setLibrary] = useState<MaterialItem[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [deleting, setDeleting] = useState<MaterialItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [status, setStatus] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await request('/materials', { headers: { 'X-User-Id': userId }, signal })
      setLibrary((await response.json() as MaterialLibrary).materials)
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
  useEffect(() => { if (deleting) dialog.current?.showModal() }, [deleting])

  async function remove() {
    if (!deleting || busy) return
    setBusy(true)
    setFailure('')
    try {
      const response = await request('/materials/commands', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({ operation: 'delete', materialId: deleting.id }),
      })
      setLibrary((await response.json() as MaterialLibrary).materials)
      setStatus(`已删除「${deleting.label}」。`)
      dialog.current?.close()
      // The deleted item's button is gone, so focus returns to the page heading.
      headingRef.current?.focus()
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) onUnauthorized()
      else if (error instanceof HttpError && error.status === 404) { setFailure('这份材料已不存在。列表已刷新。'); void load() }
      else setFailure('暂时无法删除。请检查网络后重试。')
    } finally {
      setBusy(false)
    }
  }

  return <div className="settings-content material-library-page">
    <header className="settings-heading">
      <h1 id={heading.id} ref={headingRef} tabIndex={-1}>{heading.text}</h1>
      <p>你附加过的原文都保存在这里，可以在任何对话里通过「附加原文」直接选用。</p>
    </header>
    <p role="status" className="sr-only">{status}</p>
    {loadError && <div className="notice notice-error">
      <p role="alert">暂时无法读取材料。请检查网络连接后重试。</p>
      <button type="button" onClick={() => { setLoadError(false); void load() }}>重新读取</button>
    </div>}
    {library && !library.length && <p className="learning-empty">还没有保存过材料。在对话里附加原文后，它会出现在这里。</p>}
    {library && library.length > 0 && <ul className="material-items">
      {library.map(item => <li key={item.id}>
        <div>
          <h2>{item.label}</h2>
          <p>{count(item.length)} 字 · {day(item.createdAt)} 保存 · {item.conversations ? `用于 ${item.conversations} 个对话` : '还没有在对话里使用'}</p>
        </div>
        <button type="button" onClick={() => { setFailure(''); setDeleting(item) }} aria-label={`删除 ${item.label}`}>删除</button>
      </li>)}
    </ul>}
    <dialog ref={dialog} className="memory-dialog" aria-labelledby="material-delete-title"
      onCancel={event => { if (busy) event.preventDefault() }} onClose={() => setDeleting(null)}>
      <h2 id="material-delete-title">删除这份材料？</h2>
      {deleting && <p>「{deleting.label}」的全文会被删除，无法恢复。读过它的对话里，相关回复和以它为依据的复习也会一并清除；对话本身和你发出的消息会保留。</p>}
      {failure && <p role="alert" className="form-error">{failure}</p>}
      <div className="memory-actions">
        <button type="button" autoFocus disabled={busy} onClick={() => dialog.current?.close()}>取消</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{busy ? '正在删除…' : '删除材料'}</button>
      </div>
    </dialog>
  </div>
}
