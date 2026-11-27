export class HttpError extends Error {
  constructor(readonly status: number, readonly response?: Response) {
    super(`HTTP ${status}`)
  }
}

export async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
  })
  if (!response.ok) throw new HttpError(response.status, response)
  return response
}
