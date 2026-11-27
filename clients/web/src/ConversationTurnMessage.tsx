import { memo } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { ConversationCitation, ConversationSource, ConversationTurn } from '../../../src/contracts/conversation'

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

function SourceQuotes({ sources }: { sources: ConversationSource[] }) {
  return <>{sources.map(source => <figure className="source-quote" key={source.id}>
    <figcaption>{source.label}</figcaption><blockquote>{source.text}</blockquote>
  </figure>)}</>
}

export function ConversationTurnMessage({ turn, status, preview, memory }: {
  turn: ConversationTurn; status?: ReactNode; preview?: string; memory?: ReactNode
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
          <Citations citations={block.kind === 'excerpt' ? [block.source] : block.citations} />
        </div>
      }) : preview ? <ReplyMarkdown text={preview} streaming /> : status}
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
