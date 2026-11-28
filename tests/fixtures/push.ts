import { once } from 'node:events'
import { createServer } from 'node:http'

// The fake push service that browser tests run; the test server accepts endpoints on this origin.
export const testPushOrigin = 'http://127.0.0.1:3319'

export async function startPushService() {
  const received: { path: string; encoding: string | undefined; authorization: string | undefined; size: number }[] = []
  const server = createServer(async (request, response) => {
    let size = 0
    for await (const chunk of request) size += (chunk as Buffer).length
    received.push({ path: request.url!, encoding: request.headers['content-encoding'], authorization: request.headers.authorization, size })
    response.writeHead(201).end()
  })
  const { port, hostname } = new URL(testPushOrigin)
  server.listen(Number(port), hostname)
  await once(server, 'listening')
  return { received, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
