import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import { conversationMaterialSelectionSchema } from '../../../src/contracts/conversation'

const DraftSchema = z.strictObject({
  messageText: z.string(), requestId: z.uuid().optional(), reviewInvitationId: z.uuid().optional(),
  materialSelection: conversationMaterialSelectionSchema.optional(),
  // Not sent yet: a source to attach to the next message, and whether that message leaves the current discussion.
  attachment: z.union([
    z.strictObject({ label: z.string(), text: z.string() }),
    z.strictObject({ materialId: z.uuid(), label: z.string(), length: z.int() }),
  ]).optional(),
  leaveDiscussion: z.boolean().optional(),
  // The learning goal a new conversation starts under, chosen before its first message.
  goalId: z.uuid().optional(),
})
type Draft = z.infer<typeof DraftSchema>

const draftKey = (userId: string, conversationId: string) => 'human-epochs:conversation-draft:' + userId + ':' + conversationId

// Opens a new conversation that will start under a goal, as "接着学" on the Today page does.
export function startConversationUnderGoal(userId: string, conversationId: string, goalId: string) {
  try {
    sessionStorage.setItem(draftKey(userId, conversationId), JSON.stringify({ messageText: '', goalId }))
  } catch { /* Without storage the conversation simply starts outside the goal. */ }
}

export function useConversationDraft(userId: string, conversationId: string) {
  const key = draftKey(userId, conversationId)
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
      if (value.messageText || value.attachment || value.leaveDiscussion || value.goalId) sessionStorage.setItem(key, JSON.stringify(value))
      else sessionStorage.removeItem(key)
    } catch { /* Editing and sending still work without browser storage. */ }
  }, [key])
  return { draft, currentDraft, saveDraft }
}
