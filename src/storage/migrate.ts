import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool): Promise<void> {
  const directory = resolve("migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("No SQL migrations found.");
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
    const applied = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    for (const [index, row] of applied.rows.entries()) {
      if (row.filename !== files[index]) {
        throw new Error(`Migration history does not match the files in order at ${row.filename}.`);
      }
    }
    for (const [index, filename] of files.entries()) {
      const sql = await readFile(resolve(directory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
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
