const conversationPath = /^#\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u

export const conversationHref = (conversationId: string) => `#/c/${conversationId}` as const

export function conversationRoute(hash: string) {
  return conversationPath.exec(hash.toLowerCase())?.[1] ?? null
}
