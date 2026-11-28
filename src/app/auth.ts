import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { User } from "../contracts/session.js";

const deriveKey = promisify(scrypt);
const hashLength = 64;
export const sessionLifetimeSeconds = 7 * 24 * 60 * 60;

type Account = Omit<User, "canManageAgentSettings" | "emailVerified"> & { emailVerified: boolean };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await deriveKey(password, salt, hashLength) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string | undefined): Promise<boolean> {
  // Unknown accounts do the same key derivation as existing accounts.
  const [algorithm, salt, digest] = (storedHash ?? "").split(":");
  const derived = await deriveKey(password, salt || "00000000000000000000000000000000", hashLength) as Buffer;
  if (algorithm !== "scrypt" || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  return expected.length === derived.length && timingSafeEqual(derived, expected);
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function sessionUser(pool: Pool, token: string | undefined): Promise<Account | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await pool.query<Account>(`
    SELECT u.id, u.display_name AS "displayName", u.email, u.email_verified_at IS NOT NULL AS "emailVerified"
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > now()
  `, [tokenDigest(token)]);
  return result.rows[0] ?? null;
}

export async function createSession(pool: Pool | PoolClient, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES ($1, $2, now() + $3 * interval '1 second')
  `, [tokenDigest(token), userId, sessionLifetimeSeconds]);
  return token;
}

export function createAuthService(pool: Pool, settingsAdminEmails = process.env.AGENT_SETTINGS_ADMIN_EMAILS ?? "", verification = false) {
  const admins = new Set(settingsAdminEmails.toLowerCase().split(",").map(email => email.trim()).filter(Boolean));
  const withPermissions = (account: Account): User => ({
    ...account, emailVerified: verification ? account.emailVerified : null, canManageAgentSettings: admins.has(account.email),
  });

  async function signIn(email: string, password: string) {
    const result = await pool.query<Account & { passwordHash: string }>(`
      SELECT id, email, display_name AS "displayName", email_verified_at IS NOT NULL AS "emailVerified", password_hash AS "passwordHash"
      FROM users WHERE email = $1
    `, [email]);
    const account = result.rows[0];
    const verified = await verifyPassword(password, account?.passwordHash);
    if (!verified || !account) return null;
    const { id, displayName, email: accountEmail, emailVerified } = account;
    return { user: withPermissions({ id, displayName, email: accountEmail, emailVerified }), token: await createSession(pool, id) };
  }

  async function signOut(token: string | undefined) {
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenDigest(token)]);
  }

  async function getUser(token: string | undefined) {
    const account = await sessionUser(pool, token);
    return account ? withPermissions(account) : null;
  }

  return { signIn, signOut, getUser };
}
