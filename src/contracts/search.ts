import { z } from 'zod'

export const searchQueryLimit = 100
export const searchTermLimit = 5

// Space-separated words; every word must appear in the same title or message.
export const searchQuerySchema = z.strictObject({ q: z.string().trim().min(1).max(searchQueryLimit) })

export interface SearchMatch {
  // The turn that matched, or null when the conversation title matched.
  requestId: string | null
  field: 'title' | 'message' | 'reply'
  snippet: string
  // Whether text was cut before or after the snippet.
  clippedStart: boolean
  clippedEnd: boolean
  // Matched ranges in the snippet as [start, end) UTF-16 offsets, in order and not overlapping.
  highlights: [number, number][]
}

export interface SearchResult {
  conversationId: string
  title: string
  updatedAt: string
  matches: SearchMatch[]
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  // More conversations matched than were returned.
  truncated: boolean
}
