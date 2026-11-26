import type { Pool, PoolClient } from "pg";
import { publishedDiscussions } from "../../curriculum/catalog.js";
import { inTransaction } from "../../storage/transaction.js";
import { createActivity } from "../../activities/activities.js";
import { readPublishedMaterial } from "../chat/materials.js";
import { readDiscussion } from "../chat/turns.js";

export function startPractice(pool: Pool, learnerId: string, requestId: string) {
  return inTransaction(pool, async db => {
    await db.query("SELECT id FROM learners WHERE id = $1 FOR UPDATE", [learnerId]);
    const material = await readPublishedMaterial(db, learnerId, requestId);
    if (!material) return null;
    const practiceVersion = publishedDiscussions.find(item => item.version === material.version)?.practiceVersion;
    if (!practiceVersion) return null;
    const { discussionId } = material;
    const prior = (await db.query<{ activityId: string }>(`
      SELECT activity_id AS "activityId" FROM discussion_practices WHERE learner_id = $1 AND discussion_id = $2
    `, [learnerId, discussionId])).rows[0];
    if (prior) return prior;
    const created = await createActivity(db, learnerId, practiceVersion);
    if (!created) return null;
    await db.query(`
      INSERT INTO discussion_practices (learner_id, discussion_id, source_request_id, activity_id)
      VALUES ($1, $2, $3, $4)
    `, [learnerId, discussionId, requestId, created.activityId]);
    return created;
  });
}

export async function readDiscussionOrigin(db: PoolClient, learnerId: string, activityId: string) {
  const link = (await db.query<{ id: string }>(`
    SELECT source_request_id AS id FROM discussion_practices WHERE learner_id = $1 AND activity_id = $2
  `, [learnerId, activityId])).rows[0];
  return link ? { turns: await readDiscussion(db, learnerId, link.id) } : null;
}
