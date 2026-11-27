import type { FastifyInstance } from "fastify";
import type { createLearningService } from "../app/learning-record.js";
import { learningCommandSchema } from "../contracts/learning.js";

export function registerLearningRecord(api: FastifyInstance, learning: ReturnType<typeof createLearningService>) {
  api.get("/learning-record", request => learning.read(request.user!.id));
  api.post("/learning-record/commands", async (request, reply) => {
    const command = learningCommandSchema.safeParse(request.body);
    if (!command.success) return reply.code(400).send({ message: "请刷新学习记录后再试。" });
    const record = await learning.apply(request.user!.id, command.data);
    return record ?? reply.code(404).send({ message: "找不到这个复习主题。请刷新学习记录。" });
  });
}
