import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { processNextSummary } from './summaries.js'

export function attachConversationSummaryWorker(app: FastifyInstance, pool: Pool, config: Parameters<typeof processNextSummary>[1]) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setInterval>
  let running: Promise<unknown> | undefined
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      running ??= processNextSummary(pool, config, controller.signal)
        .catch(() => console.error('Could not process a conversation summary.'))
        .finally(() => { running = undefined })
    }, 2_000)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    clearInterval(timer)
    controller.abort()
    await running
  })
}
