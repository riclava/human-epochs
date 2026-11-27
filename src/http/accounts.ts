import type { FastifyInstance, FastifyReply } from "fastify";
import { registerAccount, runAccountCommand } from "../app/accounts.js";
import { sessionLifetimeSeconds } from "../app/auth.js";
import { createRateLimit } from "../app/rate-limit.js";
import { accountCommandSchema, registrationSchema } from "../contracts/session.js";
import type { Pool } from "pg";

export const sessionCookie = "he_session";

export interface RegistrationPolicy {
  open: boolean;
  // Registrations allowed per address in an hour.
  perHour?: number;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookie, token, {
    path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: sessionLifetimeSeconds,
  });
}

export function registerSignUp(api: FastifyInstance, pool: Pool, policy: RegistrationPolicy) {
  const limit = createRateLimit({ limit: policy.perHour ?? 5, windowMs: 60 * 60 * 1000 });
  api.get("/registration", async () => ({ open: policy.open }));
  api.post("/register", async (request, reply) => {
    if (!policy.open) return reply.code(403).send({ message: "暂未开放注册。请联系部署方开通账号。" });
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请检查邮箱、名字和密码。" });
    if (!limit.take(request.ip)) return reply.code(429).send({ message: "注册太频繁。请一小时后再试。" });
    const outcome = await registerAccount(pool, parsed.data);
    if (outcome.kind === "taken") return reply.code(409).send({ message: "这个邮箱已经注册。请直接登录。" });
    setSessionCookie(reply, outcome.token);
    return reply.code(201).send({ userId: outcome.userId });
  });
}

export function registerAccountCommands(api: FastifyInstance, pool: Pool) {
  api.post("/account/commands", async (request, reply) => {
    const command = accountCommandSchema.safeParse(request.body);
    if (!command.success) return reply.code(400).send({ message: "请检查填写的内容。" });
    const outcome = await runAccountCommand(pool, request.user!.id, request.cookies[sessionCookie]!, command.data);
    if (outcome.kind === "wrong_password") return reply.code(403).send({ message: "密码不正确。" });
    if (outcome.kind === "deleted") return reply.clearCookie(sessionCookie, { path: "/" }).code(204).send();
    return reply.code(204).send();
  });
}
