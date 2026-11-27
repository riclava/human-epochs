import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AccountCommand, Registration } from "../contracts/session.js";
import { inTransaction } from "../storage/transaction.js";
import { createSession, hashPassword, tokenDigest, verifyPassword } from "./auth.js";

export type RegistrationOutcome = { kind: "registered"; userId: string; token: string } | { kind: "taken" };
export type AccountOutcome = { kind: "done" } | { kind: "wrong_password" } | { kind: "deleted" };

// Registration creates the user and the first session together, so a new account is signed in at once.
export async function registerAccount(pool: Pool, registration: Registration): Promise<RegistrationOutcome> {
  const passwordHash = await hashPassword(registration.password);
  return inTransaction(pool, async db => {
    const userId = randomUUID();
    const { rowCount } = await db.query(`
      INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING
    `, [userId, registration.email, registration.displayName, passwordHash]);
    if (!rowCount) return { kind: "taken" as const };
    return { kind: "registered" as const, userId, token: await createSession(db, userId) };
  });
}

async function lockedPasswordHash(db: PoolClient, userId: string) {
  const { rows: [user] } = await db.query<{ passwordHash: string }>(
    `SELECT password_hash AS "passwordHash" FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  return user?.passwordHash;
}

// Deleting an account removes everything the user owns. Most tables follow the user row; discussion activities
// point at turns without following them, so they go first.
async function deleteAccount(db: PoolClient, userId: string) {
  await db.query("DELETE FROM discussion_activities WHERE user_id = $1", [userId]);
  await db.query("DELETE FROM users WHERE id = $1", [userId]);
}

// Changing the password signs out every other device; the device that changed it stays signed in.
export async function runAccountCommand(pool: Pool, userId: string, sessionToken: string, command: AccountCommand): Promise<AccountOutcome> {
  if (command.operation === "rename") {
    await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [userId, command.displayName]);
    return { kind: "done" };
  }
  const password = command.operation === "change_password" ? command.currentPassword : command.password;
  const newHash = command.operation === "change_password" ? await hashPassword(command.newPassword) : null;
  return inTransaction(pool, async db => {
    if (!await verifyPassword(password, await lockedPasswordHash(db, userId))) return { kind: "wrong_password" as const };
    if (command.operation === "delete") {
      await deleteAccount(db, userId);
      return { kind: "deleted" as const };
    }
    await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, newHash]);
    await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, tokenDigest(sessionToken)]);
    return { kind: "done" as const };
  });
}
