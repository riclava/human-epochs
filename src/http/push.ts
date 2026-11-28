import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createPushReminders } from "../app/push-reminders.js";
import { sessionCookie } from "./accounts.js";

// The shape PushSubscription.toJSON() gives in the browser.
const subscriptionSchema = z.object({
  endpoint: z.url().max(1000),
  expirationTime: z.number().nullable().optional(),
  keys: z.strictObject({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/u), auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/u) }),
});

export function registerPush(api: FastifyInstance, push: ReturnType<typeof createPushReminders>) {
  api.get("/push", async () => ({ available: push.available, publicKey: push.publicKey }));
  api.post("/push/subscriptions", async (request, reply) => {
    if (!push.available) return reply.code(503).send({ message: "暂不支持复习提醒。" });
    const body = subscriptionSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: "这个浏览器的推送信息无效。" });
    const saved = await push.subscribe(request.user!.id, request.cookies[sessionCookie]!, {
      endpoint: body.data.endpoint, p256dh: body.data.keys.p256dh, auth: body.data.keys.auth,
    });
    return saved ? reply.code(204).send() : reply.code(400).send({ message: "不支持这个浏览器的推送服务。" });
  });
  api.post("/push/subscriptions/remove", async (request, reply) => {
    const body = z.strictObject({ endpoint: z.string().max(1000) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: "请刷新后再试。" });
    await push.unsubscribe(request.user!.id, body.data.endpoint);
    return reply.code(204).send();
  });
}
