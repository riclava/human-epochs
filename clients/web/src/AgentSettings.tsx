import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { agentSettingLimits, agentSettingsViewSchema, deepSeekContextTokens, defaultAgentSettings, isDeepSeekEndpoint,
  modelBaseUrlSchema, saveAgentSettingsRequestSchema, saveAgentSettingsSchema } from '../../../src/contracts/agent-settings'
import type { AgentSettingsView, SettingsAdvice } from '../../../src/contracts/agent-settings'
import { HttpError, request } from './api'
import { SettingsAssistant } from './SettingsAssistant'

type Key = keyof typeof agentSettingLimits
type ConnectionField = 'baseUrl' | 'modelId' | 'apiKey'
const connectionErrors: Record<ConnectionField, string> = {
  baseUrl: '请输入有效的 Base URL，例如 https://api.deepseek.com。',
  modelId: '请输入有效的模型 ID。',
  apiKey: '请输入有效的 API Key。',
}
type Field = { key: Key; label: string; unit: string; description?: string }
const groups: { id: string; title: string; description: string; fields: Field[] }[] = [
  {
    id: 'generation', title: '模型生成', description: '控制每次调用可生成的内容量。',
    fields: [{ key: 'maxOutputTokens', label: '输出上限', unit: 'Token' }],
  },
  {
    id: 'context', title: '上下文与材料', description: '控制发送给模型的历史和原文。',
    fields: [
      { key: 'historyBytes', label: '历史预算', unit: '字节', description: '按较早的完整问答裁剪，保留当前问题。' },
      { key: 'inlineSourceChars', label: '原文直传阈值', unit: '字符', description: '超过阈值时先提供目录，由模型按需读取。' },
    ],
  },
  {
    id: 'execution', title: '执行预算', description: '每次尝试最多运行 90 秒。',
    fields: [
      { key: 'modelTimeoutSeconds', label: '单次模型超时', unit: '秒' },
      { key: 'maxModelCalls', label: '长材料模型调用上限', unit: '次', description: '包含用于生成最终回复的一次调用。' },
      { key: 'maxToolCalls', label: '长材料工具调用上限', unit: '次' },
    ],
  },
]
const fields = groups.flatMap(group => group.fields)
const formatNumber = new Intl.NumberFormat('zh-CN')

function SettingsForm({ initial, learnerId, onUnauthorized, onReload }: {
  initial: AgentSettingsView
  learnerId: string
  onUnauthorized: () => void
  onReload: () => void
}) {
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState<Partial<Record<Key, string>>>({})
  const [baseUrl, setBaseUrl] = useState(initial.connection.baseUrl)
  const [modelId, setModelId] = useState(initial.connection.modelId)
  const [apiKey, setApiKey] = useState('')
  const [invalid, setInvalid] = useState<Set<Key>>(new Set())
  const [connectionError, setConnectionError] = useState<{ field: ConnectionField; message: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle')
  const activeSave = useRef<AbortController | null>(null)
  const reloadButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => activeSave.current?.abort(), [])
  useEffect(() => { if (status === 'conflict') reloadButton.current?.focus() }, [status])

  const value = (key: Key) => draft[key] ?? String(saved.settings[key])
  const addressChanged = (modelBaseUrlSchema.safeParse(baseUrl).data ?? baseUrl) !== saved.connection.baseUrl
  const connectionChanged = addressChanged || modelId.trim() !== saved.connection.modelId || Boolean(apiKey.trim())
  const outputDefault = addressChanged ? isDeepSeekEndpoint(baseUrl) ? defaultAgentSettings.maxOutputTokens : 2_048 : saved.defaultOutputTokens
  const dirty = connectionChanged
    || fields.some(({ key }) => value(key) !== String(saved.settings[key]))
  const saving = status === 'saving'
  const locked = saving || status === 'conflict'

  function parseDraft() {
    const entries = fields.map(({ key }) => [key, value(key) === '' ? NaN : Number(value(key))])
    return saveAgentSettingsSchema.safeParse({ revision: saved.revision, settings: Object.fromEntries(entries) })
  }

  function showConnectionError(field: ConnectionField, message = connectionErrors[field]) {
    setConnectionError({ field, message })
    document.getElementById(`settings-${field}`)?.focus()
  }

  function updateConnection(setValue: (value: string) => void, value: string) {
    setValue(value)
    setConnectionError(null)
    setStatus('idle')
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!dirty || activeSave.current || status === 'conflict') return
    const numeric = parseDraft()
    if (!numeric.success) {
      const errors = new Set(numeric.error.issues.map(issue => issue.path[1] as Key))
      setInvalid(errors)
      const first = fields.find(({ key }) => errors.has(key))
      if (first) document.getElementById(first.key)?.focus()
      return
    }
    const parsed = saveAgentSettingsRequestSchema.safeParse({ ...numeric.data, connection: connectionChanged ? {
      baseUrl, modelId, ...(apiKey.trim() ? { apiKey } : {}),
    } : undefined })
    if (!parsed.success) {
      showConnectionError(parsed.error.issues[0].path[1] as ConnectionField)
      return
    }

    const controller = new AbortController()
    activeSave.current = controller
    setStatus('saving')
    try {
      const response = await request('/agent-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Learner-Id': learnerId },
        body: JSON.stringify(parsed.data), signal: controller.signal,
      })
      const snapshot = agentSettingsViewSchema.parse(await response.json())
      if (controller.signal.aborted) return
      setSaved(snapshot)
      setDraft({})
      setBaseUrl(snapshot.connection.baseUrl)
      setModelId(snapshot.connection.modelId)
      setApiKey('')
      setStatus('saved')
    } catch (error) {
      if (controller.signal.aborted) return
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) onUnauthorized()
      if (error instanceof HttpError && (error.status === 400 || error.status === 503)) {
        const detail = await error.response?.json().catch(() => null)
        if (controller.signal.aborted) return
        if ((detail?.field === 'baseUrl' || detail?.field === 'apiKey') && typeof detail.message === 'string') {
          showConnectionError(detail.field, detail.message)
          setStatus('idle')
          return
        }
      }
      setStatus(error instanceof HttpError && error.status === 409 ? 'conflict' : 'error')
    } finally {
      activeSave.current = null
    }
  }

  function useDefaults() {
    setDraft(Object.fromEntries(fields.map(({ key }) => [key, String(key === 'maxOutputTokens'
      ? outputDefault : defaultAgentSettings[key])])))
    setInvalid(new Set())
    setStatus('idle')
  }

  function apply(changes: SettingsAdvice['changes']) {
    const entries = fields.filter(({ key }) => changes[key] !== undefined).map(({ key }) => [key, String(changes[key])])
    setDraft(current => ({ ...current, ...Object.fromEntries(entries) }))
    if (changes.modelId) setModelId(changes.modelId)
    setInvalid(new Set())
    setStatus('idle')
  }

  function describe(changes: SettingsAdvice['changes']) {
    const lines = fields.flatMap(({ key, label, unit }) => changes[key] === undefined ? [] : [
      `${label} ${value(key)} → ${formatNumber.format(changes[key])} ${unit}`,
    ])
    if (changes.modelId) lines.unshift(`模型 ID ${modelId} → ${changes.modelId}`)
    return lines
  }

  return (
    <>
    <SettingsAssistant available={saved.assistantAvailable} learnerId={learnerId} getDraft={() => parseDraft().data?.settings}
      describe={describe} apply={apply} onUnauthorized={onUnauthorized} locked={locked} />
    <form className="settings-form" onSubmit={save} noValidate aria-busy={saving}>
      <section className="settings-section" aria-labelledby="model-connection-heading">
        <div className="settings-section-heading">
          <h2 id="model-connection-heading">模型连接</h2>
          <p>使用 OpenAI 兼容的 Chat Completions 接口。</p>
        </div>
        <div className="settings-model-fields">
          <div className="settings-model-address"><label htmlFor="settings-baseUrl">Base URL</label>
            <input id="settings-baseUrl" type="url" value={baseUrl} required maxLength={512} readOnly={locked}
              autoComplete="off" spellCheck={false} aria-invalid={connectionError?.field === 'baseUrl' || undefined}
              aria-describedby={connectionError?.field === 'baseUrl' ? 'settings-model-error' : undefined}
              onChange={event => updateConnection(setBaseUrl, event.target.value)} />
          </div>
          <div><label htmlFor="settings-apiKey">API Key</label>
            <input id="settings-apiKey" type="password" value={apiKey} maxLength={4_096} readOnly={locked} autoComplete="new-password"
              aria-invalid={connectionError?.field === 'apiKey' || undefined}
              aria-describedby={connectionError?.field === 'apiKey' ? 'settings-key-status settings-model-error' : 'settings-key-status'}
              onChange={event => updateConnection(setApiKey, event.target.value)} />
            <p id="settings-key-status" className="settings-range">{addressChanged ? '请输入新地址对应的 API Key。'
              : saved.connection.hasApiKey ? '已配置。留空继续使用当前密钥。' : '尚未配置 API Key。'}</p>
          </div>
          <div><label htmlFor="settings-modelId">模型 ID</label>
            <input id="settings-modelId" value={modelId} required maxLength={160} readOnly={locked} autoComplete="off" spellCheck={false}
              aria-invalid={connectionError?.field === 'modelId' || undefined}
              aria-describedby={connectionError?.field === 'modelId' ? 'settings-model-error' : undefined}
              onChange={event => updateConnection(setModelId, event.target.value)} />
          </div>
          {isDeepSeekEndpoint(baseUrl) && <p className="settings-range">模型上下文上限 {formatNumber.format(deepSeekContextTokens)} Token</p>}
          {connectionError && <p id="settings-model-error" role="alert" className="settings-field-error">{connectionError.message}</p>}
        </div>
      </section>
      {groups.map(({ id, title, description, fields }) => (
        <section className="settings-section" key={id} aria-labelledby={`${id}-heading`}>
          <div className="settings-section-heading">
            <h2 id={`${id}-heading`}>{title}</h2>
            <p>{description}</p>
          </div>
          <div className="settings-fields">
            {fields.map(({ key, label, unit, description }) => {
              const { min } = agentSettingLimits[key]
              const { max } = agentSettingLimits[key]
              const hasError = invalid.has(key)
              return (
                <div className="settings-row" key={key}>
                  <div className="settings-field-label">
                    <label htmlFor={key}>{label}</label>
                    {description && <p id={`${key}-description`}>{description}</p>}
                  </div>
                  <div className="settings-field-control">
                    <div className="settings-input">
                      <input id={key} type="number" inputMode="numeric" required min={min} max={max} step="1"
                        value={value(key)} readOnly={saving || status === 'conflict'} aria-invalid={hasError || undefined}
                        aria-describedby={`${key}-range${description ? ` ${key}-description` : ''}${hasError ? ` ${key}-error` : ''}`}
                        onChange={event => {
                          const input = event.target.value
                          setDraft(current => ({ ...current, [key]: input }))
                          if (hasError) setInvalid(new Set([...invalid].filter(item => item !== key)))
                          setStatus('idle')
                        }} />
                      <span aria-hidden="true">{unit}</span>
                    </div>
                    <p className="settings-range" id={`${key}-range`}>
                      {`${formatNumber.format(min)}–${formatNumber.format(max)} ${unit}，`}
                      <span>{`默认 ${formatNumber.format(key === 'maxOutputTokens' ? outputDefault : defaultAgentSettings[key])}`}</span>
                    </p>
                    {hasError && <p id={`${key}-error`} className="settings-field-error" role="alert">请输入范围内的整数。</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
      <footer className="settings-footer">
        <div>
          <p className="settings-save-state" role="status">
            {status === 'saved' ? '设置已保存。' : dirty ? '有未保存的更改。' : saved.revision === 0 ? '当前使用默认设置。' : '当前设置已保存。'}
          </p>
          {status === 'error' && <p className="settings-field-error" role="alert">无法保存设置。请检查网络连接后再次保存。</p>}
          {status === 'conflict' && <p className="settings-field-error" role="alert">另一处已保存设置。读取最新设置后再修改。</p>}
        </div>
        <div className="settings-actions">
          {status === 'conflict' ? <button ref={reloadButton} type="button" onClick={onReload}>读取最新设置</button> : <>
            <button type="button" disabled={saving} onClick={useDefaults}>使用默认值</button>
            <button type="submit" className="primary" disabled={saving || !dirty}>{saving ? '正在保存…' : '保存设置'}</button>
          </>}
        </div>
      </footer>
    </form>
    </>
  )
}

export function AgentSettings({ learnerId, onUnauthorized }: { learnerId: string; onUnauthorized: () => void }) {
  const [snapshot, setSnapshot] = useState<AgentSettingsView | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)

  function reload() {
    setSnapshot(null)
    setLoadError(false)
    setLoadAttempt(attempt => attempt + 1)
    heading.current?.focus()
  }

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const response = await request('/agent-settings', { headers: { 'X-Learner-Id': learnerId }, signal: controller.signal })
        const loaded = agentSettingsViewSchema.parse(await response.json())
        if (!controller.signal.aborted) setSnapshot(loaded)
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) onUnauthorized()
        else setLoadError(true)
      }
    }
    void load()
    return () => controller.abort()
  }, [learnerId, onUnauthorized, loadAttempt])

  return (
    <div className="settings-content">
      <header className="settings-heading">
        <h1 ref={heading} id="settings-heading" tabIndex={-1}>运行设置</h1>
        <p>调整所有学习者的在线模型运行参数。保存后在下一次请求尝试中生效。</p>
      </header>
      {snapshot ? <SettingsForm initial={snapshot} learnerId={learnerId} onUnauthorized={onUnauthorized} onReload={reload} />
        : loadError ? <div className="notice notice-error">
          <p role="alert">无法读取运行设置。请检查网络连接后重试。</p>
          <button type="button" onClick={reload}>重新读取设置</button>
        </div> : <p role="status">正在读取运行设置…</p>}
    </div>
  )
}
