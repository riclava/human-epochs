import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { createPersonalMemoryService } from '../app/memory/personal.js'
import { memoryCommandSchema } from '../contracts/memory.js'

export function registerMemory(api: FastifyInstance, memory: ReturnType<typeof createPersonalMemoryService>) {
  api.get('/memories', request => memory.read(request.learner!.id))
  api.get<{ Params: { id: string } }>('/memories/source/:id', async (request, reply) => {
    const id = z.uuid().safeParse(request.params.id)
    const source = id.success && await memory.source(request.learner!.id, id.data.toLowerCase())
    return source || reply.code(404).send({ message: '找不到这条来源消息。' })
  })
  api.post('/memories', async (request, reply) => {
    const parsed = memoryCommandSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ message: '请核对记忆内容和有效期后重试。' })
    const result = await memory.change(request.learner!.id, parsed.data)
    switch (result.kind) {
      case 'saved': return result.snapshot
      case 'conflict': return reply.code(409).send({ message: '这条记忆已更新。请重新读取后再修改。' })
      case 'missing': return reply.code(404).send({ message: '找不到这条记忆。请重新读取列表。' })
      case 'invalid_source': return reply.code(400).send({ message: '请从自己的已完成对话中选择来源。' })
    }
  })
}
