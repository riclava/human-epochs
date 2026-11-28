const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
// A conversation address may name one of its turns, as search results do.
const conversationPath = new RegExp(`^#/c/(${uuid})(?:/t/(${uuid}))?$`, 'u')

export const conversationHref = (conversationId: string) => `#/c/${conversationId}` as const
export const conversationTurnHref = (conversationId: string, requestId: string) => `#/c/${conversationId}/t/${requestId}` as const

export function conversationRoute(hash: string) {
  return conversationPath.exec(hash.toLowerCase())?.[1] ?? null
}

export function conversationTurnRoute(hash: string) {
  return conversationPath.exec(hash.toLowerCase())?.[2] ?? null
}

export const searchHref = (query = '') => (query ? `#/search?q=${encodeURIComponent(query)}` : '#/search') as `#/${string}`

export function searchRoute(hash: string) {
  if (hash !== '#/search' && !hash.startsWith('#/search?')) return null
  return new URLSearchParams(hash.slice('#/search'.length)).get('q') ?? ''
}

// Links sent by mail open these pages whether or not someone is signed in.
export type RecoveryRoute = { kind: 'reset-password' | 'verify-email'; token: string }

export function recoveryRoute(hash: string): RecoveryRoute | null {
  const match = /^#\/(reset-password|verify-email)\?(.*)$/u.exec(hash)
  if (!match) return null
  return { kind: match[1] as RecoveryRoute['kind'], token: new URLSearchParams(match[2]).get('token') ?? '' }
}
