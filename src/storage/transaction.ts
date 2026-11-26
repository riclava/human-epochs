import type { Pool, PoolClient } from "pg";

export async function inTransaction<T>(pool: Pool, receive: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const outcome = await receive(db);
    await db.query("COMMIT");
    return outcome;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
