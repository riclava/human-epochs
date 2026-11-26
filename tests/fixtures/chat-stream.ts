import type { ChatContent, ChatContentDraft, ChatStreamEvent } from '../../src/contracts/chat.js'
import { readServerEvents } from '../../src/contracts/event-stream.js'

export const testModelBaseUrl = 'http://127.0.0.1:3317'

export async function readChatTurn(body: string, contentType: string) {
  const response = new Response(body, { headers: { 'Content-Type': contentType } })
  for await (const data of readServerEvents(response)) {
    const event: ChatStreamEvent = JSON.parse(data)
    if (event.kind === 'turn') return event.turn
  }
  throw new Error('Expected a final turn in the chat stream')
}

export function modelChunk(content: string, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] })}\n\n`
}

export function chatCitations(content: readonly ChatContentDraft[] | ChatContent | null) {
  return content?.flatMap(block => block.kind === 'text' ? block.citations ?? [] :
    block.kind === 'excerpt' ? [block.source] : []) ?? []
}
