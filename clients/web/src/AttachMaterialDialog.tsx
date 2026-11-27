import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChangeEvent, FormEvent } from 'react'
import { materialLabelLimit, materialSourceLimit } from '../../../src/contracts/conversation'
import { DocumentReadError, pageRangeLabel, pagesText, pagesThatFit, readDocument } from './document-text'
import type { MaterialItem, MaterialLibrary } from '../../../src/contracts/material'
import { request } from './api'
import type { Attachment } from './material-draft'
import { defaultLabel } from './MaterialComposer'

const count = (value: number) => value.toLocaleString('zh-CN')
const accepted = '.txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const readErrors: Record<DocumentReadError['reason'], string> = {
  too_large: '文件超过 20 MB。请只选择需要讨论的部分。',
  unsupported: '不支持这种文件。请选择 .txt、.md、.pdf 或 .docx 文件。',
  legacy_word: '不支持旧版 Word（.doc）文件。请在 Word 中另存为 .docx 后再选择。',
  no_text: '这个文件里没有可读取的文字，可能是扫描件或图片。请换一个文件，或直接粘贴文字。',
  unreadable: '无法读取这个文件，它可能已损坏或设置了密码。',
}

type Pdf = { name: string; pages: string[]; from: number; to: number }

// Pasted text or a chosen file becomes one source. Files are read in the browser; only the text is attached.
export function AttachMaterialDialog({ budget, inDiscussion, disabled, onAttach }: {
  budget: { text: number; sources: number }
  // Source IDs the continued discussion already reads.
  inDiscussion: string[]
  disabled: boolean
  onAttach: (attachment: Attachment) => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const textField = useRef<HTMLTextAreaElement>(null)
  // After attaching, the caller moves focus to the message field; only a cancelled dialog returns it to the button.
  const attached = useRef(false)
  const reading = useRef<AbortController | null>(null)
  const [text, setText] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [pdf, setPdf] = useState<Pdf | null>(null)
  const [library, setLibrary] = useState<MaterialItem[] | null>(null)
  const full = budget.sources <= 0
  const room = Math.max(0, budget.text)

  function open() {
    setText('')
    setLabel('')
    setNotice('')
    setPdf(null)
    setError(full ? `这段讨论已有 ${materialSourceLimit - budget.sources} 份原文，不能再附加。可以结束讨论后重新开始。` : '')
    setLibrary(null)
    void request('/materials').then(response => response.json() as Promise<MaterialLibrary>)
      .then(list => setLibrary(list.materials), () => setLibrary([]))
    dialog.current?.showModal()
    // Pasting is the common case, so the text field gets focus rather than the file picker that comes first.
    textField.current?.focus()
  }

  function choosePages(document: Pdf, from: number, to: number) {
    const pages = { ...document, from, to }
    setPdf(pages)
    setText(pagesText(document.pages, from, to))
    setLabel(pageRangeLabel(document.name, document.pages, from, to))
    setError('')
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    setError('')
    setNotice('')
    setPdf(null)
    setProgress('正在读取文件…')
    try {
      const document = await readDocument(file, {
        signal: controller.signal,
        onProgress: (done, total) => setProgress(`正在读取第 ${done} / ${total} 页…`),
      })
      if (controller.signal.aborted) return
      if (document.kind === 'pdf') {
        const all = pagesText(document.pages, 1, document.pages.length).length
        const fit = Math.max(1, pagesThatFit(document.pages, room))
        choosePages({ name: document.name, pages: document.pages, from: 1, to: 1 }, 1, Math.min(fit, document.pages.length))
        setNotice(fit >= document.pages.length ? `已读取 ${document.pages.length} 页。`
          : `整份文件 ${document.pages.length} 页、${count(all)} 字，超过这段讨论还能放的 ${count(room)} 字。已选第 1–${fit} 页，可以调整页码范围。`)
      } else {
        setText(document.text)
        setLabel(document.name)
        if (document.text.length > room) setNotice(`文件有 ${count(document.text.length)} 字，超过这段讨论还能放的 ${count(room)} 字。`)
      }
      textField.current?.focus()
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(readErrors[cause instanceof DocumentReadError ? cause.reason : 'unreadable'])
    } finally {
      if (reading.current === controller) {
        reading.current = null
        setProgress(null)
      }
    }
  }

  function keepWhatFits() {
    setText(text.trim().slice(0, room))
    setLabel(current => current && !current.endsWith('（节选）') ? current + '（节选）' : current)
    setNotice(`只保留了前 ${count(room)} 字。`)
    setError('')
    textField.current?.focus()
  }

  // A library material is attached by reference; the dialog closes first so focus can move to the message field.
  function choose(item: MaterialItem) {
    attached.current = true
    dialog.current?.close()
    onAttach({ materialId: item.id, label: item.label, length: item.length })
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const body = text.trim()
    if (full || progress) return
    if (!body) { setError('请粘贴原文，或从文件读取。'); textField.current?.focus(); return }
    if (body.length > room) {
      setError(`原文有 ${count(body.length)} 字，这段讨论还能放 ${count(room)} 字。请缩小页码范围或删减后再附加，或结束讨论后重新开始。`)
      textField.current?.focus()
      return
    }
    attached.current = true
    // Closing restores focus to the opener, so the attachment is handed over afterwards and the caller can move focus.
    dialog.current?.close()
    onAttach({ label: label.trim() || defaultLabel(body), text: body })
  }

  const tooLong = text.trim().length > room
  return <>
    <button ref={opener} type="button" className="attach-material" disabled={disabled} onClick={open}>附加原文</button>
    {/* The composer is itself a form, so the dialog and its form live outside it. */}
    {createPortal(<dialog ref={dialog} className="material-dialog" aria-labelledby={id + '-title'} onClose={() => {
      reading.current?.abort()
      if (!attached.current) opener.current?.focus()
      attached.current = false
    }}>
      <form onSubmit={submit} noValidate aria-busy={!!progress}>
        <h2 id={id + '-title'}>附加原文</h2>
        <p className="material-dialog-help">Agent 会根据这段原文回答，并标出引用的句子。</p>
        <label htmlFor={id + '-file'}>从文件读取（.txt、.md、.pdf、.docx）</label>
        <input id={id + '-file'} type="file" accept={accepted} disabled={full || !!progress} onChange={event => void readFile(event)} />
        <p className="material-count" role="status">{progress ?? notice}</p>
        {progress && <button type="button" onClick={() => reading.current?.abort()}>取消读取</button>}
        {pdf && <fieldset className="material-pages">
          <legend>页码范围（共 {pdf.pages.length} 页）</legend>
          <label>从第 <input type="number" min={1} max={pdf.to} value={pdf.from}
            onChange={event => choosePages(pdf, Math.min(Math.max(1, Number(event.target.value) || 1), pdf.to), pdf.to)} /> 页</label>
          <label>到第 <input type="number" min={pdf.from} max={pdf.pages.length} value={pdf.to}
            onChange={event => choosePages(pdf, pdf.from, Math.min(Math.max(pdf.from, Number(event.target.value) || pdf.from), pdf.pages.length))} /> 页</label>
        </fieldset>}
        <section className="material-library" aria-labelledby={id + '-library'}>
          <h3 id={id + '-library'}>从我的材料选择</h3>
          {library === null ? <p className="material-count">正在读取我的材料…</p>
            : !library.length ? <p className="material-count">还没有保存过材料。附加过的原文会出现在这里，可以在其他对话里直接选用。</p>
            : <ul>{library.map(item => {
              const reading = inDiscussion.includes('material:' + item.id)
              return <li key={item.id}>
                <span>{item.label}<small>（{count(item.length)} 字）</small></span>
                <button type="button" disabled={full || reading || item.length > room || !!progress}
                  aria-label={reading ? `${item.label} 已在这段讨论中` : `选用 ${item.label}`} onClick={() => choose(item)}>
                  {reading ? '已在讨论中' : item.length > room ? '超出剩余字数' : '选用'}</button>
              </li>
            })}</ul>}
        </section>
        <label htmlFor={id + '-text'}>原文</label>
        <textarea ref={textField} id={id + '-text'} rows={8} value={text} disabled={full}
          aria-describedby={id + '-count' + (error ? ' ' + id + '-error' : '')} aria-invalid={!!error || tooLong || undefined}
          onChange={event => { setText(event.target.value); setError('') }} />
        <p id={id + '-count'} className="material-count">{count(text.trim().length)} / {count(room)} 字</p>
        {tooLong && <button type="button" onClick={keepWhatFits}>只保留前 {count(room)} 字</button>}
        <label htmlFor={id + '-label'}>名称（可选）</label>
        <input id={id + '-label'} value={label} maxLength={materialLabelLimit} placeholder="默认使用原文第一句" disabled={full}
          onChange={event => setLabel(event.target.value)} />
        {error && <p id={id + '-error'} role="alert" className="form-error">{error}</p>}
        <div className="memory-actions">
          <button type="submit" className="primary" disabled={full || !!progress}>附加</button>
          <button type="button" onClick={() => dialog.current?.close()}>取消</button>
        </div>
      </form>
    </dialog>, document.body)}
  </>
}
