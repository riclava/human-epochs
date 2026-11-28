import type { Pool } from "pg";
import { readDueReviewInvitation } from "../review/invitations.js";
import { inTransaction } from "../storage/transaction.js";
import { tokenDigest } from "./auth.js";
import { sendPush, type PushSubscriptionKeys, type VapidKeys } from "./web-push.js";

// The browsers' own push services. The server sends to whatever endpoint a browser hands over, so only these hosts
// and explicitly configured origins are accepted.
const pushServiceHosts = ["fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

export function pushEndpointAllowed(endpoint: string, extraOrigins: readonly string[]) {
  const url = URL.parse(endpoint);
  if (!url) return false;
  if (extraOrigins.includes(url.origin)) return true;
  return url.protocol === "https:" && !url.port && pushServiceHosts.some(host => url.hostname === host || url.hostname.endsWith("." + host));
}

export interface PushSettings {
  vapid: VapidKeys;
  allowedOrigins: string[];
  fetch?: typeof fetch;
}

export function createPushReminders(pool: Pool, settings: PushSettings | null) {
  return {
    available: settings !== null,
    publicKey: settings?.vapid.publicKey ?? null,

    // A subscription belongs to the session that made it; a browser that subscribes again replaces its old entry.
    async subscribe(userId: string, sessionToken: string, subscription: PushSubscriptionKeys) {
      if (!settings || !pushEndpointAllowed(subscription.endpoint, settings.allowedOrigins)) return false;
      await pool.query(`
        INSERT INTO push_subscriptions (endpoint, user_id, session_token_hash, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, session_token_hash = EXCLUDED.session_token_hash,
          p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, created_at = clock_timestamp()
      `, [subscription.endpoint, userId, tokenDigest(sessionToken), subscription.p256dh, subscription.auth]);
      return true;
    },

    async unsubscribe(userId: string, endpoint: string) {
      await pool.query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [userId, endpoint]);
    },
  };
}

// Announces one due review to every device of its user, at most once per review. The review is marked before
// sending, so a crash may lose a reminder but never repeats one; the review itself still waits in the conversation.
export async function processNextPushReminder(pool: Pool, settings: PushSettings, now: () => Date, signal?: AbortSignal) {
  const claimed = await inTransaction(pool, async db => {
    const { rows: users } = await db.query<{ userId: string }>(`
      SELECT DISTINCT r.user_id AS "userId" FROM review_invitations r
      JOIN users u ON u.id = r.user_id AND u.review_reminders_enabled
      WHERE r.notified_at IS NULL AND r.question_request_id IS NULL AND NOT r.cancelled AND r.due_at <= $1
        AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id = r.user_id)
      LIMIT 20
    `, [now()]);
    for (const { userId } of users) {
      await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      // The same invitation the conversation would show, so a stopped topic or a removed source is never announced.
      const invitation = await readDueReviewInvitation(db, userId, now());
      if (!invitation) continue;
      const marked = await db.query(`
        UPDATE review_invitations SET notified_at = clock_timestamp() WHERE user_id = $1 AND id = $2 AND notified_at IS NULL
      `, [userId, invitation.reviewInvitationId]);
      if (marked.rowCount) return { userId, invitation };
    }
    return null;
  });
  if (!claimed || signal?.aborted) return !!claimed;
  const { rows: subscriptions } = await pool.query<PushSubscriptionKeys>(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1", [claimed.userId]);
  const message = {
    title: "该复习了", body: `「${claimed.invitation.topic}」到复习时间了，回来试一题吧。`,
    url: "/#/today", tag: "review-" + claimed.invitation.reviewInvitationId,
  };
  for (const subscription of subscriptions) {
    const result = await sendPush(subscription, message, settings.vapid, settings.fetch);
    if (result === "gone") await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [subscription.endpoint]);
  }
  return true;
}
