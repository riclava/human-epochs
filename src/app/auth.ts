import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Pool } from "pg";

const deriveKey = promisify(scrypt);
const hashLength = 64;
export const sessionLifetimeSeconds = 7 * 24 * 60 * 60;

export interface Learner {
  id: string;
  displayName: string;
  email: string;
  canManageAgentSettings: boolean;
}

type Account = Omit<Learner, "canManageAgentSettings">;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await deriveKey(password, salt, hashLength) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, storedHash: string | undefined): Promise<boolean> {
  // Unknown accounts do the same key derivation as existing accounts.
  const [algorithm, salt, digest] = (storedHash ?? "").split(":");
  const derived = await deriveKey(password, salt || "00000000000000000000000000000000", hashLength) as Buffer;
  if (algorithm !== "scrypt" || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  return expected.length === derived.length && timingSafeEqual(derived, expected);
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function sessionLearner(pool: Pool, token: string | undefined): Promise<Account | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await pool.query<Account>(`
    SELECT l.id, l.display_name AS "displayName", l.email
    FROM sessions s JOIN learners l ON l.id = s.learner_id
    WHERE s.token_hash = $1 AND s.expires_at > now()
  `, [tokenDigest(token)]);
  return result.rows[0] ?? null;
}

async function createSession(pool: Pool, learnerId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(`
    INSERT INTO sessions (token_hash, learner_id, expires_at)
    VALUES ($1, $2, now() + $3 * interval '1 second')
  `, [tokenDigest(token), learnerId, sessionLifetimeSeconds]);
  return token;
}

export function createAuthService(pool: Pool, settingsAdminEmails = process.env.STUDY_AGENT_ADMIN_EMAILS ?? "") {
  const admins = new Set(settingsAdminEmails.toLowerCase().split(",").map(email => email.trim()).filter(Boolean));
  const withPermissions = (account: Account): Learner => ({ ...account, canManageAgentSettings: admins.has(account.email) });

  async function signIn(email: string, password: string) {
    const result = await pool.query<Account & { passwordHash: string }>(`
      SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash"
      FROM learners WHERE email = $1
    `, [email]);
    const account = result.rows[0];
    const verified = await verifyPassword(password, account?.passwordHash);
    if (!verified || !account) return null;
    const { id, displayName, email: accountEmail } = account;
    return { learner: withPermissions({ id, displayName, email: accountEmail }), token: await createSession(pool, id) };
  }

  async function signOut(token: string | undefined) {
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenDigest(token)]);
  }

  async function getLearner(token: string | undefined) {
    const account = await sessionLearner(pool, token);
    return account ? withPermissions(account) : null;
  }

  return { signIn, signOut, getLearner };
}
