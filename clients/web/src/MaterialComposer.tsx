import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeEvent, FormEvent } from 'react'
import { materialLabelLimit, materialSourceLimit } from '../../../src/contracts/conversation'
import { describeLabels, type ActiveDiscussion, type Attachment } from './material-draft'

const fileSizeLimit = 1024 * 1024
const count = (value: number) => value.toLocaleString('zh-CN')

// Names a source after its first sentence, cut to a short label, when the user gives no name.
export function defaultLabel(text: string) {
  const firstLine = text.trim().split('\n')[0]?.trim() ?? ''
  const sentence = /^.+?[。！？.!?]/u.exec(firstLine)?.[0] ?? firstLine
  const characters = Array.from(sentence.replace(/[。！？.!?]$/u, ''))
  return characters.length > 20 ? characters.slice(0, 19).join('') + '…' : characters.join('') || '我的原文'
}

// Pasted text or a plain-text file becomes one source. Files are read in the browser and never uploaded as files.
export function AttachMaterialDialog({ budget, disabled, onAttach }: {
  budget: { text: number; sources: number }
  disabled: boolean
  onAttach: (attachment: Attachment) => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const textField = useRef<HTMLTextAreaElement>(null)
  // After attaching, the caller moves focus to the message field; only a cancelled dialog returns it to the button.
  const attached = useRef(false)
  const [text, setText] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const full = budget.sources <= 0

  function open() {
    setText('')
    setLabel('')
    setError(full ? `这段讨论已有 ${materialSourceLimit - budget.sources} 份原文，不能再附加。可以结束讨论后重新开始。` : '')
    dialog.current?.showModal()
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > fileSizeLimit) { setError('文件太大。请选择 1 MB 以内的纯文本文件，或只粘贴需要讨论的部分。'); return }
    const content = await file.text().catch(() => null)
    if (content === null || content.includes('\u0000')) { setError('无法读取这个文件。请选择 .txt 或 .md 纯文本文件。'); return }
    setText(content)
    setLabel(file.name.replace(/\.(txt|md|markdown)$/iu, ''))
    setError('')
    textField.current?.focus()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = text.trim()
    if (full) return
    if (!body) { setError('请粘贴原文，或从文件读取。'); textField.current?.focus(); return }
    if (body.length > budget.text) {
      setError(`原文有 ${count(body.length)} 字，这段讨论还能放 ${count(Math.max(0, budget.text))} 字。请删减后再附加，或结束讨论后重新开始。`)
      textField.current?.focus()
      return
    }
    attached.current = true
    // Closing restores focus to the opener, so the attachment is handed over afterwards and the caller can move focus.
    dialog.current?.close()
    onAttach({ label: label.trim() || defaultLabel(body), text: body })
  }

  return <>
    <button ref={opener} type="button" className="attach-material" disabled={disabled} onClick={open}>附加原文</button>
    {/* The composer is itself a form, so the dialog and its form live outside it. */}
    {createPortal(<dialog ref={dialog} className="material-dialog" aria-labelledby={id + '-title'} onClose={() => {
      if (!attached.current) opener.current?.focus()
      attached.current = false
    }}>
      <form onSubmit={submit} noValidate>
        <h2 id={id + '-title'}>附加原文</h2>
        <p className="material-dialog-help">Agent 会根据这段原文回答，并标出引用的句子。</p>
        <label htmlFor={id + '-text'}>原文</label>
        <textarea ref={textField} id={id + '-text'} rows={8} value={text} autoFocus disabled={full}
          aria-describedby={id + '-count' + (error ? ' ' + id + '-error' : '')} aria-invalid={!!error || undefined}
          onChange={event => { setText(event.target.value); setError('') }} />
        <p id={id + '-count'} className="material-count">{count(text.trim().length)} / {count(Math.max(0, budget.text))} 字</p>
        <label htmlFor={id + '-file'}>或从文件读取（.txt、.md）</label>
        <input id={id + '-file'} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" disabled={full}
          onChange={event => void readFile(event)} />
        <label htmlFor={id + '-label'}>名称（可选）</label>
        <input id={id + '-label'} value={label} maxLength={materialLabelLimit} placeholder="默认使用原文第一句" disabled={full}
          onChange={event => setLabel(event.target.value)} />
        {error && <p id={id + '-error'} role="alert" className="form-error">{error}</p>}
        <div className="memory-actions">
          <button type="submit" className="primary" disabled={full}>附加</button>
          <button type="button" onClick={() => dialog.current?.close()}>取消</button>
        </div>
      </form>
    </dialog>, document.body)}
  </>
}

// Tells the user what the next message will carry: a new source, the continued discussion, or neither.
export function MaterialStatus({ attachment, discussion, leaveDiscussion, disabled, onRemove, onLeave, onContinue }: {
  attachment?: Attachment
  discussion: ActiveDiscussion | null
  leaveDiscussion: boolean
  disabled: boolean
  onRemove: () => void
  onLeave: () => void
  onContinue: () => void
}) {
  if (!attachment && !discussion) return null
  return <div className="material-status">
    {discussion && (leaveDiscussion
      ? <p><span>下一条消息不再讨论：{describeLabels(discussion.labels)}</span>
        <button type="button" disabled={disabled} onClick={onContinue}>继续讨论</button></p>
      : <p><span>接着讨论：{describeLabels(discussion.labels)}</span>
        <button type="button" disabled={disabled} onClick={onLeave}>结束讨论</button></p>)}
    {attachment && <p><span>已附原文：{attachment.label}（{count(attachment.text.length)} 字）</span>
      <button type="button" disabled={disabled} onClick={onRemove} aria-label={`移除原文 ${attachment.label}`}>移除</button></p>}
  </div>
}
