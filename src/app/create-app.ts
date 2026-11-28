import type { Pool } from "pg";
import type { FastifyServerOptions } from "fastify";
import { createHttpApp, type HttpOptions } from "../http/app.js";
import type { RegistrationPolicy } from "../http/accounts.js";
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
import { createLearningGoalService } from "./learning-goals.js";
import { createAccountRecovery } from "./account-recovery.js";
import type { MailSettings } from "./mail.js";
import { createPushReminders, processNextPushReminder, type PushSettings } from "./push-reminders.js";

export function createApp(
  pool: Pool, model: ModelClient | null, settingsAdminEmails?: string, modelOptions?: ModelOptions,
  { backgroundJobs = false, logger, reviewNow, registration = { open: process.env.REGISTRATION_ENABLED === "true" }, trustProxy, production, mail = null, push = null }: {
    backgroundJobs?: boolean; logger?: FastifyServerOptions["logger"]; reviewNow?: () => Date; registration?: RegistrationPolicy;
    // How verification and password reset mail is sent; without it those features are off.
    mail?: MailSettings | null;
    // How review reminders reach devices; without it reminders are off.
    push?: PushSettings | null;
  } & Pick<HttpOptions, "trustProxy" | "production"> = {},
) {
  const settings = createAgentSettingsService(pool, model, modelOptions);
  const app = createHttpApp({
    auth: createAuthService(pool, settingsAdminEmails, mail !== null),
    conversation: createConversationService(pool, settings, reviewNow),
    activities: createActivityService(pool),
    personalMemories: createPersonalMemoryService(pool),
    learning: createLearningService(pool),
    materials: createMaterialLibrary(pool),
    goals: createLearningGoalService(pool),
    settings,
    pool,
    registration,
    now: reviewNow ?? (() => new Date()),
    push: createPushReminders(pool, push),
    recovery: createAccountRecovery(pool, mail, error => app.log.error({ err: error }, "mail failed")),
  }, { logger, trustProxy, production });
  if (backgroundJobs) attachBackgroundWorker(app, [
    { name: "conversation summary", run: signal => processNextSummary(pool, settings.execution, signal) },
    { name: "memory extraction", run: signal => processNextMemoryExtraction(pool, settings.execution, signal) },
    ...(push ? [{ name: "review reminder", run: (signal: AbortSignal) => processNextPushReminder(pool, push, reviewNow ?? (() => new Date()), signal) }] : []),
  ]);
  return app;
}
