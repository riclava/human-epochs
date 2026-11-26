import { createPool } from "../src/storage/database.js";
import { seed } from "../src/storage/seed.js";

const pool = createPool();
try {
  await seed(pool);
} finally {
  await pool.end();
}
