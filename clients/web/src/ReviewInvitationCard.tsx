import { useEffect, useRef, useState } from 'react'
import type { ConversationSnapshot, ReviewInvitationCommand, ReviewInvitation } from '../../../src/contracts/conversation'
import { HttpError, request } from './api'

const actionLabels = { accept: '试一题', later: '稍后再答', stop: '停止复习提醒' }

export function ReviewInvitationCard({ invitation, userId, conversationId, disabled, onResult, onStale, onUnauthorized }: {
  invitation: ReviewInvitation
  userId: string
  conversationId: string
  disabled: boolean
  onResult: (snapshot: ConversationSnapshot, action: ReviewInvitationCommand['action'], restoreFocus: boolean) => void
  onStale: (restoreFocus: boolean) => void
  onUnauthorized: () => void
}) {
  const [pending, setPending] = useState<ReviewInvitationCommand['action'] | null>(null)
  const [error, setError] = useState(false)
  const saved = useRef<ReviewInvitationCommand | null>(null)
  const active = useRef<AbortController | null>(null)
  const region = useRef<HTMLElement>(null)

  useEffect(() => () => active.current?.abort(), [])

  async function apply(action: ReviewInvitationCommand['action']) {
    if (active.current || disabled) return
    const command = saved.current?.action === action ? saved.current :
      { action, conversationId, commandId: crypto.randomUUID(), reviewInvitationId: invitation.reviewInvitationId }
    saved.current = command
    const controller = new AbortController()
    active.current = controller
    setPending(action)
    setError(false)
    const hasFocus = () => !!region.current?.contains(document.activeElement)
    try {
      const response = await request('/conversation/review-invitations', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        signal: controller.signal, body: JSON.stringify(command),
      })
      const snapshot: ConversationSnapshot = await response.json()
      if (!controller.signal.aborted) onResult(snapshot, action, hasFocus())
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof HttpError && cause.status === 401) onUnauthorized()
      else if (cause instanceof HttpError && (cause.status === 404 || cause.status === 409)) onStale(hasFocus())
      else setError(true)
    } finally {
      active.current = null
      if (!controller.signal.aborted) setPending(null)
    }
  }

  return <section className="review-invite" aria-label="复习邀请" ref={region} aria-busy={pending !== null}>
    <p>要不要用一道题复习「{invitation.topic}」？ <span>来自{invitation.sourceLabel}{invitation.conversationTitle && <>，对话「{invitation.conversationTitle}」</>}</span></p>
    <div className="review-actions">
      {(Object.entries(actionLabels) as [ReviewInvitationCommand['action'], string][]).map(([action, label]) => (
        <button type="button" key={action} className={action === 'accept' ? 'primary' : undefined}
          aria-disabled={disabled || pending !== null || undefined} onClick={() => void apply(action)}>
          {pending === action ? '处理中…' : label}
        </button>
      ))}
    </div>
    {error && <p className="form-error" role="alert">暂时无法更新复习邀请。请检查网络后再试。</p>}
  </section>
}
