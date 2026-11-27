import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ActivityViewSchema, type ActivityView, type RequestHintCommand, type RequestHintResult } from "../contracts/activity.js";
import { inTransaction } from "../storage/transaction.js";

export async function listActivities(db: Pool, userId: string) {
  const result = await db.query<{ activityId: string; title: string }>(`
    SELECT id AS "activityId", title FROM activities
    WHERE user_id = $1 ORDER BY id
  `, [userId]);
  return result.rows;
}

export async function getActivity(db: Pool | PoolClient, userId: string, activityId: string): Promise<ActivityView | null> {
  const result = await db.query(`
    SELECT a.id AS "activityId", a.title, a.revision, a.course_version AS "courseVersion",
           c.public_content AS content, a.claimed_hints AS "claimedHints",
           CASE WHEN cardinality(a.claimed_hints) < jsonb_array_length(c.private_content->'hints')
                THEN ARRAY['view','requestHint'] ELSE ARRAY['view'] END AS "allowedActions"
    FROM activities a
    JOIN course_versions c ON c.version = a.course_version
    WHERE a.user_id = $1 AND a.id = $2
  `, [userId, activityId]);
  if (!result.rows[0]) return null;
  const { content, ...state } = result.rows[0];
  return ActivityViewSchema.parse({ ...content, ...state });
}

export async function createActivity(db: PoolClient, userId: string, courseVersion: string, seedKey?: string) {
  const created = await db.query<{ activityId: string }>(`
    INSERT INTO activities (id, user_id, title, seed_key, course_version, revision)
    SELECT $1, $2, public_content->>'title', $3, version, 1
    FROM course_versions WHERE version = $4
    ON CONFLICT (user_id, seed_key) DO NOTHING
    RETURNING id AS "activityId"
  `, [randomUUID(), userId, seedKey ?? null, courseVersion]);
  return created.rows[0] ?? null;
}

export async function lockActivity(db: PoolClient, userId: string, activityId: string): Promise<ActivityView | null> {
  const owned = await db.query("SELECT id FROM activities WHERE user_id = $1 AND id = $2 FOR UPDATE", [userId, activityId]);
  return owned.rowCount ? getActivity(db, userId, activityId) : null;
}

type HintOutcome =
  | { kind: "received"; result: RequestHintResult }
  | { kind: "not_found" }
  | { kind: "conflict" | "exhausted"; message: string; activity: ActivityView };

export async function requestHintInTransaction(db: PoolClient, userId: string, command: RequestHintCommand): Promise<HintOutcome> {
  const { activityId, expectedRevision, commandId } = command;
  const activity = await lockActivity(db, userId, activityId);
  if (!activity) return { kind: "not_found" };

  const reusedId = "这次请求已用于领取另一条提示。请核对当前提示后再试。";
  const prior = (await db.query<{ matches: boolean; hintText: string }>(`
    SELECT activity_id = $3 AND expected_revision = $4::integer AS matches, hint_text AS "hintText"
    FROM activity_hint_receipts WHERE user_id = $1 AND command_id = $2
  `, [userId, commandId, activityId, expectedRevision])).rows[0];
  if (prior) {
    if (prior.matches) return { kind: "received", result: { hintText: prior.hintText, activity } };
    return { kind: "conflict", message: reusedId, activity };
  }
  if (activity.revision !== expectedRevision) {
    return { kind: "conflict", message: "活动已更新，请查看已领提示后再试。", activity };
  }
  if (!activity.allowedActions.includes("requestHint")) {
    return { kind: "exhausted", message: "这项活动的提示已全部领取。", activity };
  }

  const inserted = await db.query<{ hintText: string }>(`
    INSERT INTO activity_hint_receipts (user_id, command_id, activity_id, expected_revision, course_version, hint_text)
    SELECT $1, $2, $3, $4, version, private_content->'hints'->>($6::int)
    FROM course_versions WHERE version = $5
    ON CONFLICT (user_id, command_id) DO NOTHING RETURNING hint_text AS "hintText"
  `, [userId, commandId, activityId, expectedRevision, activity.courseVersion, activity.claimedHints.length]);
  const receipt = inserted.rows[0];
  if (!receipt) return { kind: "conflict", message: reusedId, activity };

  await db.query(`
    UPDATE activities SET claimed_hints = array_append(claimed_hints, $2), revision = revision + 1 WHERE id = $1
  `, [activityId, receipt.hintText]);
  const updated = (await getActivity(db, userId, activityId))!;
  return { kind: "received", result: { hintText: receipt.hintText, activity: updated } };
}

export function requestHint(pool: Pool, userId: string, command: RequestHintCommand): Promise<HintOutcome> {
  return inTransaction(pool, db => requestHintInTransaction(db, userId, command));
}
