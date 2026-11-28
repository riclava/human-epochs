import { useSyncExternalStore } from 'react'

function subscribeToHash(notify: () => void) {
  window.addEventListener('hashchange', notify)
  return () => window.removeEventListener('hashchange', notify)
}

const readHash = () => window.location.hash

export function useHash() {
  return useSyncExternalStore(subscribeToHash, readHash)
}
