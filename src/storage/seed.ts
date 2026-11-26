import { randomUUID } from "node:crypto";
import { hashPassword } from "../app/auth.js";
import { memoirCourse, publishedCourses } from "../curriculum/catalog.js";
import { createActivity } from "../activities/activities.js";
import type { Pool } from "pg";

export async function seed(pool: Pool): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Demo seeding is disabled in production.");
  const accounts = await Promise.all(["Alice", "Bob"].map(async (displayName) => ({
    displayName,
    email: `${displayName.toLowerCase()}@example.test`,
    passwordHash: await hashPassword("HumanEpochs-demo-1!"),
  })));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { version, publicContent, privateContent } of publishedCourses) {
      await client.query(`
        INSERT INTO curriculum_versions (version, public_content, private_content)
        VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING
      `, [version, publicContent, privateContent]);
      const matchingVersion = await client.query(`
        SELECT 1 FROM curriculum_versions WHERE version = $1 AND public_content = $2 AND private_content = $3
      `, [version, publicContent, privateContent]);
      if (!matchingVersion.rowCount) throw new Error(`Changed course content requires a new version: ${version}`);
    }

    for (const { displayName, email, passwordHash } of accounts) {
      await client.query(`
        INSERT INTO learners (id, email, display_name, password_hash)
        VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING
      `, [randomUUID(), email, displayName, passwordHash]);
      const learner = await client.query<{ id: string }>("SELECT id FROM learners WHERE email = $1", [email]);
      await createActivity(client, learner.rows[0]!.id, memoirCourse.version, "intro-memoir");
    }
    await client.query("COMMIT");
    console.log("Demo course and learners are ready.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
