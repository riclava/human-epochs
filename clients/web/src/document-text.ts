// Turns a chosen file into plain text in the browser. Nothing is uploaded: only the extracted text is attached.
// The PDF and Word readers load when such a file is chosen, so they do not slow down the first page load.

export const documentSizeLimit = 20 * 1024 * 1024

export type DocumentText =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'pdf'; name: string; pages: string[] }

export class DocumentReadError extends Error {
  constructor(readonly reason: 'too_large' | 'unsupported' | 'legacy_word' | 'no_text' | 'unreadable') {
    super(reason)
  }
}

const baseName = (name: string) => name.replace(/\.(txt|md|markdown|pdf|docx)$/iu, '')

function kindOf(file: File) {
  const name = file.name.toLowerCase()
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf'
  if (name.endsWith('.docx')) return 'docx'
  if (name.endsWith('.doc')) return 'doc'
  if (/\.(txt|md|markdown)$/u.test(name) || file.type.startsWith('text/')) return 'text'
  return 'other'
}

// Text items carry their own line ends; joining them this way keeps paragraphs without merging words across lines.
async function readPdf(file: File, signal?: AbortSignal, onProgress?: (done: number, total: number) => void) {
  const pdfjs = await import('pdfjs-dist')
  const { default: workerSrc } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  signal?.addEventListener('abort', () => void task.destroy(), { once: true })
  const document = await task.promise
  try {
    const pages: string[] = []
    for (let number = 1; number <= document.numPages; number++) {
      signal?.throwIfAborted()
      const content = await (await document.getPage(number)).getTextContent()
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
      pages.push(text.replace(/[ \t]+\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim())
      onProgress?.(number, document.numPages)
    }
    return pages
  } finally {
    void task.destroy()
  }
}

async function readDocx(file: File) {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
  return result.value.replace(/\n{3,}/gu, '\n\n').trim()
}

export async function readDocument(
  file: File, options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DocumentText> {
  if (file.size > documentSizeLimit) throw new DocumentReadError('too_large')
  const kind = kindOf(file)
  const name = baseName(file.name)
  try {
    if (kind === 'pdf') {
      const pages = await readPdf(file, options.signal, options.onProgress)
      if (!pages.some(page => page.length)) throw new DocumentReadError('no_text')
      return { kind: 'pdf', name, pages }
    }
    if (kind === 'docx') {
      const text = await readDocx(file)
      if (!text) throw new DocumentReadError('no_text')
      return { kind: 'text', name, text }
    }
    if (kind === 'doc') throw new DocumentReadError('legacy_word')
    if (kind === 'other') throw new DocumentReadError('unsupported')
    const text = await file.text()
    if (text.includes('\u0000')) throw new DocumentReadError('unsupported')
    return { kind: 'text', name, text }
  } catch (error) {
    if (error instanceof DocumentReadError || options.signal?.aborted) throw error
    throw new DocumentReadError('unreadable')
  }
}

// Each page starts with its number, so a quoted passage can be traced back to the page it came from.
export function pagesText(pages: readonly string[], from: number, to: number) {
  return pages.slice(from - 1, to).map((text, index) => `【第 ${from + index} 页】\n${text}`).join('\n\n')
}

// The longest page range from the first page that fits in the given character budget.
export function pagesThatFit(pages: readonly string[], budget: number) {
  let to = 0
  while (to < pages.length && pagesText(pages, 1, to + 1).length <= budget) to++
  return to
}

export function pageRangeLabel(name: string, pages: readonly string[], from: number, to: number) {
  return from === 1 && to === pages.length ? name : `${name}（第 ${from}–${to} 页）`
}
