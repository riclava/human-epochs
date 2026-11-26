import { EventSourceParserStream } from 'eventsource-parser/stream'

export function isEventStream(contentType: string | null | undefined) {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream'
}

export async function* readServerEvents(response: Response, maxBufferSize?: number) {
  if (!response.body || !isEventStream(response.headers.get('content-type'))) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Expected an event stream')
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ maxBufferSize }))
    .getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value.data
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
