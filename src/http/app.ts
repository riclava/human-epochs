import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import { sessionLifetimeSeconds, type createAuthService } from "../app/auth.js";
import type { User } from "../contracts/session.js";
import type { createActivityService } from "../app/activities/service.js";
import type { createAgentSettingsService } from "../app/agent-settings.js";
import type { createConversationService } from "../app/conversation/service.js";
import type { createPersonalMemoryService } from "../app/personal-memories.js";
import { registerActivities } from "./activities.js";
import { registerAgentSettings } from "./agent-settings.js";
import { registerConversation } from "./conversation.js";
import { registerPersonalMemories } from "./personal-memories.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

const loginSchema = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()).transform(email => email.toLowerCase()),
  password: z.string().min(1).max(1024),
});
const sessionCookie = "he_session";

interface HttpServices {
  auth: ReturnType<typeof createAuthService>;
  conversation: ReturnType<typeof createConversationService>;
  activities: ReturnType<typeof createActivityService>;
  settings: ReturnType<typeof createAgentSettingsService>;
  personalMemories: ReturnType<typeof createPersonalMemoryService>;
}

export function createHttpApp({ auth, conversation, activities, settings, personalMemories }: HttpServices, logger: FastifyServerOptions["logger"] = false) {
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
      return { user: session.user };
    });

    api.post("/logout", async (request, reply) => {
      await auth.signOut(request.cookies[sessionCookie]);
      return reply.clearCookie(sessionCookie, { path: "/" }).code(204).send();
    });

    api.register(async authenticated => {
      authenticated.decorateRequest("user", null);
      authenticated.addHook("onRequest", async (request, reply) => {
        request.user = await auth.getUser(request.cookies[sessionCookie]);
        if (!request.user) return reply.code(401).send({ message: "请先登录。" });
        const expectedUserId = request.headers["x-user-id"];
        if (expectedUserId !== undefined && expectedUserId !== request.user.id) {
          return reply.code(401).send({ message: "当前账号已更换，请刷新页面。" });
        }
      });
      authenticated.get("/session", async request => ({ user: request.user! }));
      registerConversation(authenticated, conversation, activities);
      registerActivities(authenticated, activities);
      registerAgentSettings(authenticated, settings);
      registerPersonalMemories(authenticated, personalMemories);
    });
  }, { prefix: "/api" });

  const webRoot = resolve("dist/web");
  if (existsSync(resolve(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot });
  }
  return app;
}
