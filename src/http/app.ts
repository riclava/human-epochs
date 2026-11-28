import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Pool } from "pg";
import type { createAuthService } from "../app/auth.js";
import type { User } from "../contracts/session.js";
import type { createActivityService } from "../app/activities/service.js";
import type { createAgentSettingsService } from "../app/agent-settings.js";
import type { createConversationService } from "../app/conversation/service.js";
import type { createPersonalMemoryService } from "../app/personal-memories.js";
import type { createLearningService } from "../app/learning-record.js";
import type { createMaterialLibrary } from "../app/material-library.js";
import type { createLearningGoalService } from "../app/learning-goals.js";
import { registerLearningGoals } from "./learning-goals.js";
import { registerConversationSearch } from "./conversation-search.js";
import { registerToday } from "./today.js";
import { registerAccountRecovery, registerVerificationResend } from "./account-recovery.js";
import type { createAccountRecovery } from "../app/account-recovery.js";
import { registerActivities } from "./activities.js";
import { registerAgentSettings } from "./agent-settings.js";
import { registerConversation } from "./conversation.js";
import { registerPersonalMemories } from "./personal-memories.js";
import { registerLearningRecord } from "./learning-record.js";
import { registerMaterialLibrary } from "./material-library.js";
import { createRateLimit } from "../app/rate-limit.js";
import { addSecurityHeaders } from "./security.js";
import { registerAccountCommands, registerSignUp, sessionCookie, setSessionCookie, type RegistrationPolicy } from "./accounts.js";

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

const loginSchema = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()).transform(email => email.toLowerCase()),
  password: z.string().min(1).max(1024),
});

interface HttpServices {
  auth: ReturnType<typeof createAuthService>;
  conversation: ReturnType<typeof createConversationService>;
  activities: ReturnType<typeof createActivityService>;
  settings: ReturnType<typeof createAgentSettingsService>;
  personalMemories: ReturnType<typeof createPersonalMemoryService>;
  learning: ReturnType<typeof createLearningService>;
  materials: ReturnType<typeof createMaterialLibrary>;
  goals: ReturnType<typeof createLearningGoalService>;
  // The database, for routes that read it directly: health, accounts, export and search.
  pool: Pool;
  registration: RegistrationPolicy;
  recovery: ReturnType<typeof createAccountRecovery>;
  // The clock reviews are due by.
  now: () => Date;
}

export interface HttpOptions {
  logger?: FastifyServerOptions["logger"];
  // Proxies trusted to report the client address, as Fastify's trustProxy takes them.
  trustProxy?: boolean | number;
  production?: boolean;
}

// Failed sign-ins are limited per address and per account, so guessing a password is slow from one place and
// against one person. Successful sign-ins are not counted.
const signInFailures = () => ({
  byAddress: createRateLimit({ limit: 30, windowMs: 15 * 60 * 1000 }),
  byEmail: createRateLimit({ limit: 10, windowMs: 15 * 60 * 1000 }),
});

export function createHttpApp(
  { auth, conversation, activities, settings, personalMemories, learning, materials, goals, pool, registration, recovery, now }: HttpServices,
  { logger = false, trustProxy = false, production = false }: HttpOptions = {},
) {
  // A hop count trusts that many proxies nearest the server.
  const proxies = typeof trustProxy === "number" ? (_address: string, hop: number) => hop < trustProxy : trustProxy;
  const options: FastifyServerOptions = { logger, trustProxy: proxies, logController: new LogController({ disableRequestLogging: !production }) };
  const app = Fastify(options);
  const failures = signInFailures();
  app.register(cookie);
  addSecurityHeaders(app, production);
  app.register(async api => {
    api.addHook("onRequest", async (_request, reply) => {
      reply.header("Cache-Control", "private, no-store");
    });

    api.post("/login", async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "请输入有效的电子邮箱和密码。" });
      if (failures.byAddress.blocked(request.ip) || failures.byEmail.blocked(parsed.data.email)) {
        return reply.code(429).send({ message: "尝试次数太多。请 15 分钟后再登录。" });
      }
      const session = await auth.signIn(parsed.data.email, parsed.data.password);
      if (!session) {
        failures.byAddress.record(request.ip);
        failures.byEmail.record(parsed.data.email);
        return reply.code(401).send({ message: "电子邮箱或密码不正确。" });
      }
      setSessionCookie(reply, session.token);
      return { user: session.user };
    });

    registerSignUp(api, pool, registration, recovery);
    registerAccountRecovery(api, recovery);

    // Liveness says the process answers; readiness also needs the database.
    api.get("/healthz", async () => ({ status: "ok" }));
    api.get("/readyz", async (_request, reply) => {
      try {
        await pool.query("SELECT 1");
        return { status: "ok" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
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
      registerLearningRecord(authenticated, learning);
      registerMaterialLibrary(authenticated, materials);
      registerLearningGoals(authenticated, goals);
      registerConversationSearch(authenticated, pool);
      registerToday(authenticated, pool, now);
      registerVerificationResend(authenticated, recovery);
      registerAccountCommands(authenticated, pool);
    });
  }, { prefix: "/api" });

  const webRoot = resolve("dist/web");
  if (existsSync(resolve(webRoot, "index.html"))) {
    app.register(fastifyStatic, { root: webRoot });
  }
  return app;
}
