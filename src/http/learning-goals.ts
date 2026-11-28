import type { FastifyInstance } from 'fastify'
import type { createLearningGoalService, GoalRefusal } from '../app/learning-goals.js'
import { activeLearningGoalLimit, learningGoalCommandSchema, learningGoalLimit } from '../contracts/learning-goal.js'

const refusals: Record<GoalRefusal, [number, string]> = {
  conflict: [409, '这个目标已在别处修改。请刷新后再试。'],
  missing: [404, '找不到这个目标。请刷新目标列表。'],
  limit: [409, `最多保存 ${learningGoalLimit} 个目标，同时进行中的最多 ${activeLearningGoalLimit} 个。请先暂停或完成一个。`],
  invalid_proposal: [400, '找不到这条提议。请刷新对话后再试。'],
}

export function registerLearningGoals(api: FastifyInstance, goals: ReturnType<typeof createLearningGoalService>) {
  api.get('/learning-goals', request => goals.read(request.user!.id))
  api.post('/learning-goals/commands', async (request, reply) => {
    const command = learningGoalCommandSchema.safeParse(request.body)
    if (!command.success) return reply.code(400).send({ message: '请检查目标的标题和说明。' })
    const outcome = await goals.run(request.user!.id, command.data)
    if (outcome.kind === 'saved') return outcome.list
    const [status, message] = refusals[outcome.kind]
    return reply.code(status).send({ message, reason: outcome.kind })
  })
}
