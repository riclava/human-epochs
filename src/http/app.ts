import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { sessionLifetimeSeconds, type createAuthService, type Learner } from "../app/auth.js";
import type { createActivityService } from "../app/activities/service.js";
import type { createAgentSettingsService } from "../app/agent-settings.js";
import type { createChatService } from "../app/chat/service.js";
import type { createPersonalMemoryService } from "../app/memory/personal.js";
import { registerActivities } from "./activities.js";
import { registerAgentSettings } from "./agent-settings.js";
import { registerChat } from "./chat.js";
import { registerMemory } from "./memory.js";

declare module "fastify" {
  interface FastifyRequest {
    learner: Learner | null;
  }
}

const loginSchema = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()).transform(email => email.toLowerCase()),
  password: z.string().min(1).max(1024),
});
const sessionCookie = "he_session";

interface HttpServices {
  auth: ReturnType<typeof createAuthService>;
  chat: ReturnType<typeof createChatService>;
  activities: ReturnType<typeof createActivityService>;
  settings: ReturnType<typeof createAgentSettingsService>;
  memory: ReturnType<typeof createPersonalMemoryService>;
}

export function createHttpApp({ auth, chat, activities, settings, memory }: HttpServices, logger: FastifyServerOptions["logger"] = false) {
  const app = Fastify({ logger, logController: new LogController({ disableRequestLogging: true }) });
  app.register(cookie);
  app.register(async api => {
    api.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store");
    });

    api.post("/login", async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "请输入有效的电子邮箱和密码。" });
      const session = await auth.signIn(parsed.data.email, parsed.data.password);
      if (!session) return reply.code(401).send({ message: "电子邮箱或密码不正确。" });
      reply.setCookie(sessionCookie, session.token, {
        path: "/", httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
        maxAge: sessionLifetimeSeconds,
      });
      return { learner: session.learner };
    });

    api.post("/logout", async (request, reply) => {
      await auth.signOut(request.cookies[sessionCookie]);
      return reply.clearCookie(sessionCookie, { path: "/" }).code(204).send();
    });

    api.register(async authenticated => {
      authenticated.decorateRequest("learner", null);
      authenticated.addHook("onRequest", async (request, reply) => {
        request.learner = await auth.getLearner(request.cookies[sessionCookie]);
        if (!request.learner) return reply.code(401).send({ message: "请先登录。" });
        const expectedLearner = request.headers["x-learner-id"];
        if (expectedLearner !== undefined && expectedLearner !== request.learner.id) {
          return reply.code(401).send({ message: "当前账号已更换，请刷新学习空间。" });
        }
      });
      authenticated.get("/session", async request => ({ learner: request.learner! }));
      registerChat(authenticated, chat, activities);
      registerActivities(authenticated, activities);
      registerAgentSettings(authenticated, settings);
      registerMemory(authenticated, memory);
    });
  }, { prefix: "/api" });

  const webRoot = resolve("dist/web");
  if (existsSync(resolve(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot });
  }
  return app;
}
