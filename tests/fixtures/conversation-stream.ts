import type { ConversationContent, ConversationContentDraft, ConversationStreamEvent } from '../../src/contracts/conversation.js'
import { readServerEvents } from '../../src/contracts/event-stream.js'

export const testModelBaseUrl = 'http://127.0.0.1:3317'

export async function readConversationTurn(body: string, contentType: string) {
  const response = new Response(body, { headers: { 'Content-Type': contentType } })
  for await (const data of readServerEvents(response)) {
    const event: ConversationStreamEvent = JSON.parse(data)
    if (event.kind === 'turn') {
      if (event.turn.kind !== 'user') throw new Error('Expected a user turn in the conversation stream')
      return event.turn
    }
  }
  throw new Error('Expected a final turn in the conversation stream')
}

export function modelChunk(content: string, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`
}

export function conversationCitations(content: readonly ConversationContentDraft[] | ConversationContent | null) {
  return content?.flatMap(block => block.kind === 'text' ? block.citations ?? [] :
    block.kind === 'excerpt' ? [block.source] : block.kind === 'event_log' ? block.citations : []) ?? []
}
