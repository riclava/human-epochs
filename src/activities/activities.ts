import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ActivityViewSchema, type ActivityView, type RequestHintCommand, type RequestHintResult } from "../contracts/learning.js";
import { inTransaction } from "../storage/transaction.js";

export async function listActivities(db: Pool, learnerId: string) {
  const result = await db.query<{ activityId: string; title: string }>(`
    SELECT id AS "activityId", title FROM activities
    WHERE learner_id = $1 ORDER BY id
  `, [learnerId]);
  return result.rows;
}

export async function getActivity(db: Pool | PoolClient, learnerId: string, activityId: string): Promise<ActivityView | null> {
  const result = await db.query(`
    SELECT a.id AS "activityId", a.title, a.revision, a.course_version AS "activityVersion",
           c.public_content AS content, a.published_hints AS hints,
           CASE WHEN cardinality(a.published_hints) < jsonb_array_length(c.private_content->'hints')
                THEN ARRAY['view','requestHint'] ELSE ARRAY['view'] END AS "allowedActions"
    FROM activities a
    JOIN curriculum_versions c ON c.version = a.course_version
    WHERE a.learner_id = $1 AND a.id = $2
  `, [learnerId, activityId]);
  if (!result.rows[0]) return null;
  const { content, ...state } = result.rows[0];
  return ActivityViewSchema.parse({ ...content, ...state });
}

export async function createActivity(db: PoolClient, learnerId: string, version: string, seedKey?: string) {
  const created = await db.query<{ activityId: string }>(`
    INSERT INTO activities (id, learner_id, title, seed_key, course_version, revision)
    SELECT $1, $2, public_content->>'title', $3, version, 1
    FROM curriculum_versions WHERE version = $4
    ON CONFLICT (learner_id, seed_key) DO NOTHING
    RETURNING id AS "activityId"
  `, [randomUUID(), learnerId, seedKey ?? null, version]);
  return created.rows[0] ?? null;
}

export async function lockActivity(db: PoolClient, learnerId: string, activityId: string): Promise<ActivityView | null> {
  const owned = await db.query("SELECT id FROM activities WHERE learner_id = $1 AND id = $2 FOR UPDATE", [learnerId, activityId]);
  return owned.rowCount ? getActivity(db, learnerId, activityId) : null;
}

type HintOutcome =
  | { kind: "received"; result: RequestHintResult }
  | { kind: "not_found" }
  | { kind: "conflict" | "exhausted"; message: string; activity: ActivityView };

export async function requestHintInTransaction(db: PoolClient, learnerId: string, command: RequestHintCommand): Promise<HintOutcome> {
  const { activityId, revision, commandId } = command;
  const activity = await lockActivity(db, learnerId, activityId);
  if (!activity) return { kind: "not_found" };

  const reusedId = "这次请求已用于领取另一条提示。请核对当前提示后再试。";
  const prior = (await db.query<{ matches: boolean; hint: string }>(`
    SELECT activity_id = $3 AND request_revision = $4::integer AS matches, hint_text AS hint
    FROM activity_hint_receipts WHERE learner_id = $1 AND command_id = $2
  `, [learnerId, commandId, activityId, revision])).rows[0];
  if (prior) {
    if (prior.matches) return { kind: "received", result: { hint: prior.hint, activity } };
    return { kind: "conflict", message: reusedId, activity };
  }
  if (activity.revision !== revision) {
    return { kind: "conflict", message: "活动已更新，请查看已领提示后再试。", activity };
  }
  if (!activity.allowedActions.includes("requestHint")) {
    return { kind: "exhausted", message: "这项活动的提示已全部领取。", activity };
  }

  const inserted = await db.query<{ hint: string }>(`
    INSERT INTO activity_hint_receipts (learner_id, command_id, activity_id, request_revision, activity_version, hint_text)
    SELECT $1, $2, $3, $4, version, private_content->'hints'->>($6::int)
    FROM curriculum_versions WHERE version = $5
    ON CONFLICT (learner_id, command_id) DO NOTHING RETURNING hint_text AS hint
  `, [learnerId, commandId, activityId, revision, activity.activityVersion, activity.hints.length]);
  const receipt = inserted.rows[0];
  if (!receipt) return { kind: "conflict", message: reusedId, activity };

  await db.query(`
    UPDATE activities SET published_hints = array_append(published_hints, $2), revision = revision + 1 WHERE id = $1
  `, [activityId, receipt.hint]);
  const updated = (await getActivity(db, learnerId, activityId))!;
  return { kind: "received", result: { hint: receipt.hint, activity: updated } };
}

export function requestHint(pool: Pool, learnerId: string, command: RequestHintCommand): Promise<HintOutcome> {
  return inTransaction(pool, db => requestHintInTransaction(db, learnerId, command));
}
