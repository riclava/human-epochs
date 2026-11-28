import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { createAccountRecovery } from "../app/account-recovery.js";
import { createRateLimit } from "../app/rate-limit.js";
import { passwordMinLength } from "../contracts/session.js";
import { setSessionCookie } from "./accounts.js";

type Recovery = ReturnType<typeof createAccountRecovery>;
const hour = 60 * 60 * 1000;
const email = z.string().trim().max(254).pipe(z.email()).transform(value => value.toLowerCase());
const token = z.string().max(64);
const invalidLink = { message: "链接无效或已过期。请重新申请。" };

// Links in mail are public: whoever holds a token may use it once. Asking for mail is limited per address and per
// account, and a limited reset request still answers as if it were sent.
export function registerAccountRecovery(api: FastifyInstance, recovery: Recovery) {
  const resetsByAddress = createRateLimit({ limit: 10, windowMs: hour });
  const resetsByEmail = createRateLimit({ limit: 3, windowMs: hour });

  api.post("/password-reset", async (request, reply) => {
    if (!recovery.available) return reply.code(503).send({ message: "暂不支持找回密码。请联系部署方。" });
    const body = z.strictObject({ email }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: "请输入有效的邮箱。" });
    if (!resetsByAddress.take(request.ip)) return reply.code(429).send({ message: "申请太频繁。请一小时后再试。" });
    if (resetsByEmail.take(body.data.email)) await recovery.requestPasswordReset(body.data.email);
    return reply.code(202).send();
  });

  api.post("/password-reset/confirm", async (request, reply) => {
    const body = z.strictObject({ token, password: z.string().min(passwordMinLength).max(1024) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ message: `新密码至少 ${passwordMinLength} 位。` });
    const session = await recovery.resetPassword(body.data.token, body.data.password);
    if (!session) return reply.code(410).send(invalidLink);
    setSessionCookie(reply, session);
    return reply.code(204).send();
  });

  api.post("/email-verification/confirm", async (request, reply) => {
    const body = z.strictObject({ token }).safeParse(request.body);
    if (!body.success || !await recovery.verifyEmail(body.data.token)) return reply.code(410).send(invalidLink);
    return reply.code(204).send();
  });
}

export function registerVerificationResend(api: FastifyInstance, recovery: Recovery) {
  const sends = createRateLimit({ limit: 5, windowMs: hour });
  api.post("/email-verification", async (request, reply) => {
    if (!sends.take(request.user!.id)) return reply.code(429).send({ message: "发送太频繁。请一小时后再试。" });
    const outcome = await recovery.sendVerification(request.user!.id);
    if (outcome === "unavailable") return reply.code(503).send({ message: "暂时无法发送邮件。" });
    if (outcome === "failed") return reply.code(502).send({ message: "邮件没有发出去。请稍后重试。" });
    return reply.code(outcome === "verified" ? 200 : 202).send({ status: outcome });
  });
}
