import { memo } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { ConversationCitation, ConversationTurn, MaterialSourceView } from '../../../src/contracts/conversation'
import type { PersonalMemory } from '../../../src/contracts/personal-memory'
import { Diagram } from './Diagram'
import { EventLog } from './EventLog'
import { previewReplyText } from './reply-preview'

const markdownComponents: Components = {
  h1: ({ children }) => <h2>{children}</h2>,
  h2: ({ children }) => <h3>{children}</h3>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h5>{children}</h5>,
  h5: ({ children }) => <h6>{children}</h6>,
  img: ({ alt }) => alt ?? '',
  a: ({ href, title, children }) => href ? <a href={href} title={title}>{children}</a> : <>{children}</>,
}

function webLink(url: string) {
  if (!/^https?:\/\//i.test(url)) return undefined
  return URL.parse(url)?.href
}

const ReplyMarkdown = memo(function ReplyMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return <div className="reply-markdown" aria-busy={streaming || undefined}>
    <Markdown skipHtml components={markdownComponents} urlTransform={webLink}>{text}</Markdown>
  </div>
})

// A turn shows the opening of each source it read; a long source says how much of it is shown.
function SourceQuotes({ sources }: { sources: MaterialSourceView[] }) {
  return <>{sources.map(source => <figure className="source-quote" key={source.id}>
    <figcaption>{source.label}{source.truncated && <span>（共 {source.length.toLocaleString('zh-CN')} 字，这里只显示开头）</span>}</figcaption>
    <blockquote>{source.preview}{source.truncated && '…'}</blockquote>
  </figure>)}</>
}

export function ConversationTurnMessage({ turn, status, preview, memory, usedMemories = [] }: {
  turn: ConversationTurn; status?: ReactNode; preview?: string; memory?: ReactNode
  // Memories this reply was given that the user can still see. Forgotten ones are gone from the snapshot.
  usedMemories?: PersonalMemory[]
}) {
  const explanationSource = turn.kind === 'user' ? turn.explanationSource : undefined
  const source = explanationSource && { model: '在线解释', course: '课程导读', excerpt: '原文摘录' }[explanationSource]
  const blocks = turn.kind === 'user' ? turn.replyBlocks : turn.questionBlocks
  const unavailableMessage = turn.kind === 'review_question' ? '这道复习题已不可用。' : '这部分回复已失效。'
  return <div className="conversation-turn">
    {turn.kind === 'user' && <div className="user-message"><strong className="sr-only">你</strong><p>{turn.messageText}</p>
      {turn.materialContext && <details className="turn-sources"><summary>查看当轮材料</summary>
        <SourceQuotes sources={turn.materialContext.sources} /></details>}
      {memory}
    </div>}
    <div className="agent-message"><strong>{source ?? 'Human Epochs'}</strong>
      {blocks ? blocks.map(block => {
        if (block.kind === 'unavailable') return <p key={block.id}>{unavailableMessage}</p>
        return <div key={block.id}>
          {block.kind === 'text' && <ReplyMarkdown text={block.text} streaming={false} />}
          {block.kind === 'event_log' && <EventLog block={block} />}
          {block.kind === 'diagram' && <Diagram block={block} />}
          <Citations citations={block.kind === 'excerpt' ? [block.source] : block.citations} />
        </div>
      }) : preview ? <ReplyMarkdown text={previewReplyText(preview)} streaming /> : status}
      {blocks && usedMemories.length > 0 && <details className="used-memories">
        <summary>参考了 {usedMemories.length} 条记忆</summary>
        <ul>{usedMemories.map(record => <li key={record.id}>{record.body}</li>)}</ul>
      </details>}
    </div>
  </div>
}

function Citations({ citations }: { citations?: ConversationCitation[] }) {
  if (!citations?.length) return null
  return <div role="group" aria-label="引文">{citations.map(citation =>
    <figure className="source-quote" key={citation.sourceId + ':' + citation.quote}>
      <figcaption>{citation.label}</figcaption><blockquote>{citation.quote}</blockquote>
    </figure>
  )}</div>
}
