import type { FastifyInstance } from 'fastify'

export interface BackgroundTask {
  name: string
  run: (signal: AbortSignal) => Promise<unknown>
}

// Runs each task once per tick. A tick waits for the previous one, and closing the app waits for the running tick.
export function attachBackgroundWorker(app: FastifyInstance, tasks: BackgroundTask[]) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setInterval>
  let running: Promise<unknown> | undefined
  async function tick() {
    for (const task of tasks) {
      if (controller.signal.aborted) return
      await task.run(controller.signal).catch(() => console.error(`Could not process a ${task.name}.`))
    }
  }
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      running ??= tick().finally(() => { running = undefined })
    }, 2_000)
    timer.unref()
  })
  app.addHook('onClose', async () => {
    clearInterval(timer)
    controller.abort()
    await running
  })
}
