import { createPool } from "../src/storage/database.js";
import { migrate } from "../src/storage/migrate.js";

const pool = createPool();
try {
  await migrate(pool);
} finally {
  await pool.end();
}
