import type { Pool } from "pg";
import type { FastifyServerOptions } from "fastify";
import { createHttpApp } from "../http/app.js";
import type { StudyModel } from "../runtime/model.js";
import { createActivityService } from "./activities/service.js";
import { createAgentSettingsService, type ModelOptions } from "./agent-settings.js";
import { createAuthService } from "./auth.js";
import { createChatService } from "./chat/service.js";
import { createPersonalMemoryService } from "./memory/personal.js";
import { attachSummaryWorker } from "./memory/worker.js";

export function createApp(
  pool: Pool, model: StudyModel | null, settingsAdminEmails?: string, modelOptions?: ModelOptions,
  { backgroundSummaries = false, logger }: { backgroundSummaries?: boolean; logger?: FastifyServerOptions["logger"] } = {},
) {
  const settings = createAgentSettingsService(pool, model, modelOptions);
  const app = createHttpApp({
    auth: createAuthService(pool, settingsAdminEmails),
    chat: createChatService(pool, settings),
    activities: createActivityService(pool),
    memory: createPersonalMemoryService(pool),
    settings,
  }, logger);
  if (backgroundSummaries) attachSummaryWorker(app, pool, settings.execution);
  return app;
}
