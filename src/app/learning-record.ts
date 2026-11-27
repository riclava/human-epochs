import type { Pool } from "pg";
import type { LearningCommand } from "../contracts/learning.js";
import { applyLearningCommand, readLearningRecord } from "../review/learning-record.js";
import { inTransaction } from "../storage/transaction.js";

export function createLearningService(pool: Pool) {
  return {
    read: (userId: string) => readLearningRecord(pool, userId),
    // Both commands only move state one way, so a repeated command leaves the same result.
    apply: (userId: string, command: LearningCommand) => inTransaction(pool, async db => {
      await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      return await applyLearningCommand(db, userId, command) ? readLearningRecord(db, userId) : null;
    }),
  };
}
