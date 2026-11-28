import { createModelProvider } from "../models/connections.js";
import { createPool } from "../storage/database.js";
import { migrate, verifyDatabaseSchema } from "../storage/migrate.js";
import { createModelCredentialCipher } from "../storage/model-credential.js";
import { readServerConfig } from "./config.js";
import { createApp } from "./create-app.js";
import { createMailSender } from "./mail.js";

let config;
try {
  config = readServerConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const production = config.NODE_ENV === "production";
const provider = createModelProvider(process.env);
const cipher = createModelCredentialCipher(config.MODEL_CREDENTIAL_ENCRYPTION_KEY);
const pool = createPool();
const sendMail = createMailSender(config.mail);
const app = createApp(pool, null, config.AGENT_SETTINGS_ADMIN_EMAILS, { provider, cipher }, {
  backgroundJobs: true,
  // Production logs are JSON lines on stdout for the platform to collect; request lines carry method, path and
  // status, never bodies or cookies.
  logger: production ? { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] } : { stream: process.stderr },
  registration: { open: config.REGISTRATION_ENABLED },
  trustProxy: config.TRUST_PROXY,
  mail: sendMail && { send: sendMail, baseUrl: config.publicBaseUrl },
  push: config.vapid && { vapid: config.vapid, allowedOrigins: config.PUSH_ALLOWED_ORIGINS.split(",").map(origin => origin.trim()).filter(Boolean) },
  production,
});
app.addHook("onClose", async () => { await pool.end(); });
const shutdown = async () => { await app.close(); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  if (config.MIGRATE_ON_START) await migrate(pool);
  await verifyDatabaseSchema(pool);
  const address = await app.listen({ port: config.PORT, host: config.HOST });
  console.log(`Human Epochs is listening at ${address}`);
} catch (error) {
  await app.close();
  throw error;
}
