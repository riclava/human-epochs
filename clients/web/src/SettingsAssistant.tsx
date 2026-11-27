import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { settingsAdviceSchema, settingsAssistantHistoryLimit } from '../../../src/contracts/agent-settings'
import type { AgentSettings, SettingsAdvice } from '../../../src/contracts/agent-settings'
import { HttpError, request } from './api'

type Exchange = { question: string; advice: SettingsAdvice }
type SettingsChanges = SettingsAdvice['changes']

export function SettingsAssistant({ onlineModelAvailable, userId, getDraft, describe, apply, onUnauthorized, locked }: {
  onlineModelAvailable: boolean
  userId: string
  getDraft: () => AgentSettings | undefined
  describe: (changes: SettingsChanges) => string[]
  apply: (changes: SettingsChanges) => void
  onUnauthorized: () => void
  locked: boolean
}) {
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [question, setQuestion] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const activeRequest = useRef<AbortController | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  useEffect(() => () => activeRequest.current?.abort(), [])
  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [exchanges.length])

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = question.trim()
    if (!text || !onlineModelAvailable || activeRequest.current) return

    const history = exchanges.flatMap(({ question, advice }) => [
      { role: 'user', content: question }, { role: 'assistant', content: JSON.stringify(advice) },
    ])
    history.push({ role: 'user', content: text })
    const controller = new AbortController()
    activeRequest.current = controller
    setPending(true)
    setError(false)
    try {
      const response = await request('/agent-settings/assistant', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        signal: controller.signal,
        body: JSON.stringify({ history: history.slice(-settingsAssistantHistoryLimit), draft: getDraft() }),
      })
      const advice = settingsAdviceSchema.parse(await response.json())
      if (controller.signal.aborted) return
      setExchanges(current => [...current, { question: text, advice }])
      setQuestion('')
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) onUnauthorized()
      else setError(true)
    } finally {
      activeRequest.current = null
      if (!controller.signal.aborted) setPending(false)
    }
  }

  return (
    <details className="settings-assistant">
      <summary>AI 设置助手</summary>
      <div className="settings-assistant-body">
        {onlineModelAvailable ? <>
          <p id="settings-assistant-guide">问参数怎么选，或者请 AI 拟一份设置。建议可填入表单，保存后生效。</p>
          <div ref={transcript} className="settings-dialogue" role="log" aria-label="设置对话">
            {exchanges.map(({ question, advice }, index) => {
              const changes = describe(advice.changes)
              return <div key={index} className="settings-exchange">
                <p className="settings-question"><span className="sr-only">你</span>{question}</p>
                <div className="settings-advice"><p><span className="sr-only">设置助手</span>{advice.reply}</p>
                  {changes.length > 0 && <>
                    <ul>{changes.map(change => <li key={change}>{change}</li>)}</ul>
                    <button type="button" disabled={locked} onClick={() => apply(advice.changes)}>填入表单</button>
                  </>}
                </div>
              </div>
            })}
          </div>
          <form className="settings-assistant-form" onSubmit={ask} aria-busy={pending}>
            <label htmlFor="settings-question">设置问题</label>
            <textarea id="settings-question" rows={2} maxLength={2_000} value={question} required
              readOnly={pending} aria-describedby="settings-assistant-guide" onChange={event => setQuestion(event.target.value)} />
            <div className="settings-assistant-actions">
              {error && <p role="alert">暂时无法生成建议。可重新发送或直接编辑表单。</p>}
              <button type="submit" disabled={pending || !question.trim()}>{pending ? '正在生成建议…' : '发送问题'}</button>
            </div>
          </form>
        </> : <p>配置在线模型连接后可使用设置助手。</p>}
      </div>
    </details>
  )
}
