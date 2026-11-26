import { Pool } from "pg";

export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString });
  // PostgreSQL may close an idle connection during a restart. The pool replaces it on the next checkout.
  pool.on("error", () => console.error("PostgreSQL closed an idle connection."));
  return pool;
}
