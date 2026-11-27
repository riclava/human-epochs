import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

async function readMigrations() {
  const directory = resolve("migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("No SQL migrations found.");
  return Promise.all(files.map(async filename => {
    const sql = await readFile(resolve(directory, filename), "utf8");
    return { filename, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

type AppliedMigration = { filename: string; checksum: string };
const appliedMigrations = "SELECT filename, checksum FROM schema_migrations ORDER BY filename";
const initialize = "请先运行 npm run db:migrate 初始化数据库。";

export async function verifyDatabaseSchema(pool: Pool): Promise<void> {
  const expected = await readMigrations();
  const result = await pool.query<AppliedMigration>(appliedMigrations).catch((error: { code?: string }) => {
    if (error.code === "42P01") throw new Error(initialize);
    throw error;
  });
  if (!result.rows.length) throw new Error(initialize);
  if (result.rows.length !== expected.length || result.rows.some((row, index) =>
    row.filename !== expected[index]?.filename || row.checksum !== expected[index]?.checksum)) {
    throw new Error("数据库结构与当前代码不一致。请将 DATABASE_URL 指向新的空库，再运行 npm run db:migrate。");
  }
}

export async function migrate(pool: Pool): Promise<void> {
  const files = await readMigrations();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('human-epochs:migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await client.query<AppliedMigration>(appliedMigrations);
    for (const [index, row] of applied.rows.entries()) {
      if (row.filename !== files[index]?.filename) {
        throw new Error(`Migration history does not match the files in order at ${row.filename}.`);
      }
    }
    for (const [index, { filename, sql, checksum }] of files.entries()) {
      const existing = applied.rows[index];
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${filename}`);
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [filename, checksum]);
    }
    await client.query("COMMIT");
    console.log(`Applied ${files.length - applied.rows.length} migration(s).`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
