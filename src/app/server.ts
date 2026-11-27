import { createPool } from "../storage/database.js";
import { createModelProvider } from "../models/connections.js";
import { createModelCredentialCipher } from "../storage/model-credential.js";
import { verifyDatabaseSchema } from "../storage/migrate.js";
import { createApp } from "./create-app.js";

const provider = createModelProvider(process.env);
const cipher = createModelCredentialCipher(process.env.MODEL_CREDENTIAL_ENCRYPTION_KEY);
const pool = createPool();
const app = createApp(pool, null, undefined, { provider, cipher }, { backgroundSummaries: true, logger: { stream: process.stderr } });
app.addHook("onClose", async () => { await pool.end(); });
const shutdown = async () => { await app.close(); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await verifyDatabaseSchema(pool);
  const address = await app.listen({ port: Number(process.env.PORT ?? 3001), host: process.env.HOST ?? "127.0.0.1" });
  console.log(`Human Epochs is listening at ${address}`);
} catch (error) {
  await app.close();
  throw error;
}
