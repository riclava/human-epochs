import { once } from 'node:events'
import { createServer } from 'node:http'

export const testMailUrl = 'http://127.0.0.1:3318/emails'

export interface CapturedMail {
  to: string[]
  subject: string
  text: string
}

// A stand-in for the mail provider's HTTP API. Mail sent while it runs is kept in order.
export async function startMailbox() {
  const mail: CapturedMail[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    mail.push(JSON.parse(body))
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"fixture"}')
  })
  const { port, hostname } = new URL(testMailUrl)
  server.listen(Number(port), hostname)
  await once(server, 'listening')
  return {
    mail,
    // The link in the newest mail to this address.
    linkFor: (to: string) => /https?:\/\/\S+/u.exec([...mail].reverse().find(item => item.to.includes(to))?.text ?? '')?.[0],
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
