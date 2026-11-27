import type { Pool, PoolClient } from "pg";
import { publishedDiscussions } from "../../courses/catalog.js";
import { inTransaction } from "../../storage/transaction.js";
import { createActivity } from "../../activities/activities.js";
import { readPublishedMaterialContext } from "../conversation/materials.js";
import { readDiscussion } from "../conversation/turns.js";

export function startDiscussionActivity(pool: Pool, userId: string, requestId: string) {
  return inTransaction(pool, async db => {
    await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const materialContext = await readPublishedMaterialContext(db, userId, requestId);
    if (!materialContext) return null;
    const practiceCourseVersion = publishedDiscussions.find(item => item.discussionVersion === materialContext.discussionVersion)?.practiceCourseVersion;
    if (!practiceCourseVersion) return null;
    const { discussionId } = materialContext;
    const prior = (await db.query<{ activityId: string }>(`
      SELECT activity_id AS "activityId" FROM discussion_activities WHERE user_id = $1 AND discussion_id = $2
    `, [userId, discussionId])).rows[0];
    if (prior) return prior;
    const created = await createActivity(db, userId, practiceCourseVersion);
    if (!created) return null;
    await db.query(`
      INSERT INTO discussion_activities (user_id, discussion_id, source_request_id, activity_id)
      VALUES ($1, $2, $3, $4)
    `, [userId, discussionId, requestId, created.activityId]);
    return created;
  });
}

export async function readDiscussionOrigin(db: PoolClient, userId: string, activityId: string) {
  const link = (await db.query<{ id: string }>(`
    SELECT source_request_id AS id FROM discussion_activities WHERE user_id = $1 AND activity_id = $2
  `, [userId, activityId])).rows[0];
  return link ? { turns: await readDiscussion(db, userId, link.id) } : null;
}
