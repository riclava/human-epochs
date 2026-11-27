import type { Pool } from "pg";
import type { FastifyServerOptions } from "fastify";
import { createHttpApp } from "../http/app.js";
import type { ModelClient } from "../runtime/model.js";
import { createActivityService } from "./activities/service.js";
import { createAgentSettingsService, type ModelOptions } from "./agent-settings.js";
import { createAuthService } from "./auth.js";
import { attachBackgroundWorker } from "./background-worker.js";
import { createConversationService } from "./conversation/service.js";
import { processNextSummary } from "./conversation/summaries.js";
import { processNextMemoryExtraction } from "./memory-extraction.js";
import { createPersonalMemoryService } from "./personal-memories.js";
import { createLearningService } from "./learning-record.js";
import { createMaterialLibrary } from "./material-library.js";

export function createApp(
  pool: Pool, model: ModelClient | null, settingsAdminEmails?: string, modelOptions?: ModelOptions,
  { backgroundJobs = false, logger, reviewNow }: {
    backgroundJobs?: boolean; logger?: FastifyServerOptions["logger"]; reviewNow?: () => Date;
  } = {},
) {
  const settings = createAgentSettingsService(pool, model, modelOptions);
  const app = createHttpApp({
    auth: createAuthService(pool, settingsAdminEmails),
    conversation: createConversationService(pool, settings, reviewNow),
    activities: createActivityService(pool),
    personalMemories: createPersonalMemoryService(pool),
    learning: createLearningService(pool),
    materials: createMaterialLibrary(pool),
    settings,
  }, logger);
  if (backgroundJobs) attachBackgroundWorker(app, [
    { name: "conversation summary", run: signal => processNextSummary(pool, settings.execution, signal) },
    { name: "memory extraction", run: signal => processNextMemoryExtraction(pool, settings.execution, signal) },
  ]);
  return app;
}
