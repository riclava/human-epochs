import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { searchQueryLimit, type SearchMatch, type SearchResponse } from '../../../src/contracts/search'
import { HttpError, request } from './api'
import { conversationHref, conversationTurnHref, searchHref, searchRoute } from './routes'
import { useHash, type WorkspacePageProps } from './workspace-pages'

const fieldLabel: Record<SearchMatch['field'], string> = { title: '标题', message: '你的消息', reply: '回复' }

function Snippet({ match }: { match: SearchMatch }) {
  const parts: ReactNode[] = []
  let cursor = 0
  for (const [start, end] of match.highlights) {
    parts.push(match.snippet.slice(cursor, start), <mark key={start}>{match.snippet.slice(start, end)}</mark>)
    cursor = end
  }
  parts.push(match.snippet.slice(cursor))
  return <>{match.clippedStart && '…'}{parts}{match.clippedEnd && '…'}</>
}

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error' } | { kind: 'done'; response: SearchResponse }

// The query lives in the address, so a search can be reloaded, shared between tabs and returned to with Back.
export function ConversationSearchView({ userId, onUnauthorized, heading }: WorkspacePageProps) {
  const query = searchRoute(useHash()) ?? ''
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!query.trim()) {
      setState({ kind: 'idle' })
      input.current?.focus()
      return
    }
    const controller = new AbortController()
    setState({ kind: 'loading' })
    request('/conversation-search?q=' + encodeURIComponent(query), { headers: { 'X-User-Id': userId }, signal: controller.signal })
      .then(response => response.json() as Promise<SearchResponse>)
      .then(response => setState({ kind: 'done', response }), error => {
        if (controller.signal.aborted) return
        if (error instanceof HttpError && error.status === 401) onUnauthorized()
        else setState({ kind: 'error' })
      })
    return () => controller.abort()
  }, [query, userId, onUnauthorized, attempt])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const next = String(new FormData(event.currentTarget).get('q') ?? '').trim()
    if (next === query) setAttempt(value => value + 1)
    else window.location.hash = searchHref(next)
  }

  const count = state.kind === 'done' ? state.response.results.length : 0
  return <div className="settings-content search-page">
    <header className="settings-heading">
      <h1 id={heading.id} tabIndex={-1}>{heading.text}</h1>
      <p>在你的对话标题、消息和回复里查找。用空格分开多个词时，结果需要同时包含这些词。</p>
    </header>
    <form role="search" className="search-form" onSubmit={submit}>
      <label htmlFor="conversation-search" className="sr-only">搜索内容</label>
      <input ref={input} id="conversation-search" name="q" type="search" defaultValue={query} key={query}
        maxLength={searchQueryLimit} placeholder="例如：等压线" autoComplete="off" />
      <button type="submit" className="primary">搜索</button>
    </form>
    <p role="status" className="search-status">
      {state.kind === 'loading' ? '正在搜索…'
        : state.kind === 'done' ? (count ? `找到 ${count} 个对话${state.response.truncated ? '，只显示最近的 20 个' : ''}。` : `没有找到包含「${query}」的对话。换个词或减少几个词再试。`)
        : ''}
    </p>
    {state.kind === 'error' && <div className="notice notice-error">
      <p role="alert">暂时无法搜索。请检查网络连接后重试。</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>重新搜索</button>
    </div>}
    {state.kind === 'done' && count > 0 && <ol className="search-results">
      {state.response.results.map(result => <li key={result.conversationId}>
        <h2><a href={conversationHref(result.conversationId)}>{result.title}</a></h2>
        <ul>{result.matches.filter(match => match.requestId).map(match =>
          <li key={match.requestId + match.field}>
            <a href={conversationTurnHref(result.conversationId, match.requestId!)}>
              <span className="search-field">{fieldLabel[match.field]}</span>
              <span className="search-snippet"><Snippet match={match} /></span>
            </a>
          </li>)}</ul>
      </li>)}
    </ol>}
  </div>
}
