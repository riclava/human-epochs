import type { Pool } from "pg";
import type { FastifyServerOptions } from "fastify";
import { createHttpApp } from "../http/app.js";
import type { ModelClient } from "../runtime/model.js";
import { createActivityService } from "./activities/service.js";
import { createAgentSettingsService, type ModelOptions } from "./agent-settings.js";
import { createAuthService } from "./auth.js";
import { createConversationService } from "./conversation/service.js";
import { createPersonalMemoryService } from "./personal-memories.js";
import { attachConversationSummaryWorker } from "./conversation/summary-worker.js";

export function createApp(
  pool: Pool, model: ModelClient | null, settingsAdminEmails?: string, modelOptions?: ModelOptions,
  { backgroundSummaries = false, logger, reviewNow }: {
    backgroundSummaries?: boolean; logger?: FastifyServerOptions["logger"]; reviewNow?: () => Date;
  } = {},
) {
  const settings = createAgentSettingsService(pool, model, modelOptions);
  const app = createHttpApp({
    auth: createAuthService(pool, settingsAdminEmails),
    conversation: createConversationService(pool, settings, reviewNow),
    activities: createActivityService(pool),
    personalMemories: createPersonalMemoryService(pool),
    settings,
  }, logger);
  if (backgroundSummaries) attachConversationSummaryWorker(app, pool, settings.execution);
  return app;
}
