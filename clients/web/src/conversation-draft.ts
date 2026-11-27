import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { conversationMaterialSelectionSchema } from '../../../src/contracts/conversation'

const DraftSchema = z.strictObject({
  messageText: z.string(), requestId: z.uuid().optional(), reviewInvitationId: z.uuid().optional(),
  materialSelection: conversationMaterialSelectionSchema.optional(),
})
type Draft = z.infer<typeof DraftSchema>

export function useConversationDraft(userId: string, conversationId: string) {
  const key = 'human-epochs:conversation-draft:' + userId + ':' + conversationId
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = DraftSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? 'null'))
      if (saved.success) return saved.data
    } catch { /* Private browsing may prevent storage access. */ }
    return { messageText: '' }
  })
  const currentDraft = useRef(draft)
  const saveDraft = useCallback((value: Draft) => {
    currentDraft.current = value
    setDraft(value)
    try {
      if (value.messageText) sessionStorage.setItem(key, JSON.stringify(value))
      else sessionStorage.removeItem(key)
    } catch { /* Editing and sending still work without browser storage. */ }
  }, [key])
  return { draft, currentDraft, saveDraft }
}
