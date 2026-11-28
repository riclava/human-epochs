import { useEffect, useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { conversationTurnRoute } from './routes'
import { useHash } from './workspace-pages'

// Opens a conversation at the turn its address names, as a search result does: the turn is scrolled to the middle,
// following the latest reply stops, and focus moves to the turn so reading continues from there.
export function useTurnTarget(ready: boolean, followLatest: RefObject<boolean>) {
  const turnId = conversationTurnRoute(useHash())
  useLayoutEffect(() => {
    if (!ready || !turnId) return
    const element = document.getElementById('turn-' + turnId)
    if (!element) return
    followLatest.current = false
    element.scrollIntoView({ block: 'center' })
  }, [ready, turnId, followLatest])
  // The workspace moves focus to the main area in its own layout effect, so this runs afterwards.
  useEffect(() => {
    if (ready && turnId) document.getElementById('turn-' + turnId)?.focus({ preventScroll: true })
  }, [ready, turnId])
  return turnId
}
