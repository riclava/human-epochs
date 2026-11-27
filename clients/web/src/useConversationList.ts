import { useCallback, useEffect, useState } from 'react'
import type { ConversationList, ConversationListItem } from '../../../src/contracts/conversation'
import { HttpError, request } from './api'

interface ListState {
  items: ConversationListItem[]
  loaded: boolean
  error: boolean
}

export function useConversationList(userId: string, onUnauthorized: () => void) {
  const [state, setState] = useState<ListState>({ items: [], loaded: false, error: false })
  const [version, setVersion] = useState(0)
  const refresh = useCallback(() => setVersion(value => value + 1), [])

  useEffect(() => {
    const controller = new AbortController()
    request('/conversations', { headers: { 'X-User-Id': userId }, signal: controller.signal })
      .then(response => response.json() as Promise<ConversationList>)
      .then(list => { if (!controller.signal.aborted) setState({ items: list.conversations, loaded: true, error: false }) })
      .catch(error => {
        if (controller.signal.aborted) return
        if (error instanceof HttpError && error.status === 401) onUnauthorized()
        else setState(previous => ({ ...previous, loaded: true, error: true }))
      })
    return () => controller.abort()
  }, [userId, version, onUnauthorized])

  // Another device may have started or continued a conversation while this page was hidden.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  return { ...state, refresh }
}
