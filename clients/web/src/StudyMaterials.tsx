import { memo } from 'react'
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { ChatCitation, ChatSource, ChatTurn } from '../../../src/contracts/chat'

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

function SourceQuotes({ sources }: { sources: ChatSource[] }) {
  return <>{sources.map(source => <figure className="source-quote" key={source.id}>
    <figcaption>{source.label}</figcaption><blockquote>{source.text}</blockquote>
  </figure>)}</>
}

export function StudyTurnMessage({ turn, status, preview }: { turn: ChatTurn; status?: ReactNode; preview?: string }) {
  const source = turn.explanationMode && { model: '在线解释', course: '课程导读', excerpt: '原文摘录' }[turn.explanationMode]
  return <div className="study-turn">
    <div className="learner-message"><strong className="sr-only">你</strong><p>{turn.text}</p>
      {turn.material && <details className="turn-sources"><summary>查看当轮材料</summary>
        <SourceQuotes sources={turn.material.sources} /></details>}
      {turn.status === 'complete' && <a className="memory-source-link" href={'#/memory?source=' + turn.requestId}>保存到个人记忆</a>}
    </div>
    <div className="agent-message"><strong>{source ?? '学习 Agent'}</strong>
      {turn.content ? turn.content.map(block => {
        if (block.kind === 'unavailable') return <p key={block.id}>这部分回复已失效。</p>
        return <div key={block.id}>
          {block.kind === 'text' && <ReplyMarkdown text={block.text} streaming={false} />}
          <Citations citations={block.kind === 'excerpt' ? [block.source] : block.citations} />
        </div>
      }) : preview ? <ReplyMarkdown text={preview} streaming /> : status}
    </div>
  </div>
}

function Citations({ citations }: { citations?: ChatCitation[] }) {
  if (!citations?.length) return null
  return <div aria-label="引用原文">{citations.map(citation =>
    <figure className="source-quote" key={citation.id + ':' + citation.quote}>
      <figcaption>{citation.label}</figcaption><blockquote>{citation.quote}</blockquote>
    </figure>
  )}</div>
}
