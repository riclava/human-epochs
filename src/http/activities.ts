import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createActivityService } from "../app/activities/service.js";
import { chatTextLimit } from "../contracts/chat.js";
import { RequestHintCommandSchema } from "../contracts/learning.js";

const activityId = z.uuid();
const normalizedId = activityId.toLowerCase();
const discussionMessage = z.strictObject({
  requestId: normalizedId, revision: z.int().positive().max(2147483647),
  text: z.string().trim().min(1).max(chatTextLimit).refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value)),
  intent: z.enum(["message", "hint"]).optional(),
});
type ActivityParams = { Params: { id: string } };
const notFound = { message: "找不到这项活动。" };

export function registerActivities(api: FastifyInstance, activities: ReturnType<typeof createActivityService>) {
  api.get("/activities", async request => ({ activities: await activities.listActivities(request.learner!.id) }));
  api.get<ActivityParams>("/activities/:id", async (request, reply) => {
    const id = request.params.id;
    if (!activityId.safeParse(id).success) return reply.code(404).send(notFound);
    const activity = await activities.getActivity(request.learner!.id, id);
    return activity ?? reply.code(404).send(notFound);
  });
  api.post<ActivityParams>("/activities/:id/hints", async (request, reply) => {
    const id = request.params.id;
    if (!activityId.safeParse(id).success) return reply.code(404).send(notFound);
    const parsed = RequestHintCommandSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.activityId !== id.toLowerCase()) {
      return reply.code(400).send({ message: "请重新打开这项练习，再领取提示。" });
    }
    const outcome = await activities.requestHint(request.learner!.id, parsed.data);
    switch (outcome.kind) {
      case "received": return outcome.result;
      case "not_found": return reply.code(404).send(notFound);
      case "exhausted":
      case "conflict": return reply.code(409).send({ message: outcome.message, activity: outcome.activity });
    }
  });

  api.get<ActivityParams>("/activities/:id/chat", async (request, reply) => {
    const id = normalizedId.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send(notFound);
    const snapshot = await activities.readDiscussion(request.learner!.id, id.data);
    return snapshot ?? reply.code(404).send(notFound);
  });

  api.post<ActivityParams>("/activities/:id/chat", async (request, reply) => {
    const id = normalizedId.safeParse(request.params.id);
    if (!id.success) return reply.code(404).send(notFound);
    const parsed = discussionMessage.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请输入 1 至 4000 个字符后重新发送。" });
    const outcome = await activities.sendMessage(request.learner!.id, id.data, parsed.data);
    if (!outcome) return reply.code(404).send(notFound);
    if ("message" in outcome) return reply.code(409).send(outcome);
    if (outcome.turn.status === "conflict") return reply.code(409).send({ ...outcome, message: outcome.turn.reply });
    return outcome;
  });
}
