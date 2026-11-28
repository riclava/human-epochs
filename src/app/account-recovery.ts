import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { inTransaction } from "../storage/transaction.js";
import { createSession, hashPassword, tokenDigest } from "./auth.js";
import type { MailSettings } from "./mail.js";

type Purpose = "verify_email" | "reset_password";
const lifetimeMinutes: Record<Purpose, number> = { verify_email: 24 * 60, reset_password: 60 };
export const emailTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

// Issues a single-use link token. Only its digest is stored, and an earlier unused token for the same purpose stops
// working, so only the newest mail counts.
async function issueToken(db: Pool | PoolClient, userId: string, email: string, purpose: Purpose) {
  const token = randomBytes(32).toString("base64url");
  await db.query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [userId, purpose]);
  await db.query(`
    INSERT INTO email_tokens (token_hash, user_id, purpose, email, expires_at)
    VALUES ($1, $2, $3, $4, clock_timestamp() + $5 * interval '1 minute')
  `, [tokenDigest(token), userId, purpose, email, lifetimeMinutes[purpose]]);
  return token;
}

// A token works once, before it expires, and only while the account still has the address it was sent to.
async function consumeToken(db: PoolClient, token: string, purpose: Purpose) {
  if (!emailTokenPattern.test(token)) return null;
  const { rows: [row] } = await db.query<{ userId: string }>(`
    UPDATE email_tokens t SET used_at = clock_timestamp()
    FROM users u
    WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > clock_timestamp()
      AND u.id = t.user_id AND u.email = t.email
    RETURNING t.user_id AS "userId"
  `, [tokenDigest(token), purpose]);
  return row?.userId ?? null;
}

const verifyMail = (baseUrl: string, token: string) => [
  "你好！", "", "请打开下面的链接，确认这是你在 Human Epochs 使用的邮箱：", `${baseUrl}/#/verify-email?token=${token}`, "",
  "链接 24 小时内有效。如果你没有注册 Human Epochs，可以忽略这封邮件。",
].join("\n");

const resetMail = (baseUrl: string, token: string) => [
  "你好！", "", "我们收到了重置 Human Epochs 密码的请求。请打开下面的链接设置新密码：", `${baseUrl}/#/reset-password?token=${token}`, "",
  "链接 1 小时内有效，只能使用一次。如果不是你本人操作，可以忽略这封邮件，你的密码不会改变。",
].join("\n");

export function createAccountRecovery(pool: Pool, mail: MailSettings | null, log: (error: unknown) => void = () => {}) {
  // Mail goes out after the token is saved; a failed send is logged and the user can ask again.
  const send = (to: string, subject: string, text: string) => mail!.send({ to, subject, text }).then(() => true, error => {
    log(error);
    return false;
  });

  return {
    available: mail !== null,

    async sendVerification(userId: string) {
      if (!mail) return "unavailable" as const;
      const { rows: [user] } = await pool.query<{ email: string; verified: boolean }>(
        "SELECT email, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1", [userId]);
      if (!user) return "unavailable" as const;
      if (user.verified) return "verified" as const;
      const token = await issueToken(pool, userId, user.email, "verify_email");
      return await send(user.email, "确认你的 Human Epochs 邮箱", verifyMail(mail.baseUrl, token)) ? "sent" as const : "failed" as const;
    },

    async verifyEmail(token: string) {
      return inTransaction(pool, async db => {
        const userId = await consumeToken(db, token, "verify_email");
        if (!userId) return false;
        await db.query("UPDATE users SET email_verified_at = coalesce(email_verified_at, clock_timestamp()) WHERE id = $1", [userId]);
        return true;
      });
    },

    // Answers the same whether or not the address has an account, so the form cannot be used to find accounts.
    async requestPasswordReset(email: string) {
      if (!mail) return;
      const { rows: [user] } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
      if (!user) return;
      const token = await issueToken(pool, user.id, email, "reset_password");
      await send(email, "重置你的 Human Epochs 密码", resetMail(mail.baseUrl, token));
    },

    // Setting a new password signs out every device and signs this one in. Opening the link also proves the address.
    async resetPassword(token: string, password: string) {
      const passwordHash = await hashPassword(password);
      return inTransaction(pool, async db => {
        const userId = await consumeToken(db, token, "reset_password");
        if (!userId) return null;
        await db.query(`
          UPDATE users SET password_hash = $2, email_verified_at = coalesce(email_verified_at, clock_timestamp()) WHERE id = $1
        `, [userId, passwordHash]);
        await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
        await db.query("DELETE FROM email_tokens WHERE user_id = $1 AND purpose = 'reset_password' AND used_at IS NULL", [userId]);
        return createSession(db, userId);
      });
    },
  };
}
