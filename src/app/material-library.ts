import type { Pool, PoolClient } from "pg";
import type { MaterialLibrary } from "../contracts/material.js";
import { inTransaction } from "../storage/transaction.js";
import { materialSourceId } from "./conversation/materials.js";

// Turns whose saved sources include the material. Course sources never use "material:" IDs.
const readsMaterial = `material_context->'sources' @> jsonb_build_array(jsonb_build_object('id', $2::text))`;

export async function readMaterialLibrary(db: Pool | PoolClient, userId: string): Promise<MaterialLibrary> {
  const { rows } = await db.query<{ id: string; label: string; length: number; createdAt: Date; conversations: number }>(`
    SELECT m.id, m.label, m.length, m.created_at AS "createdAt", (
      SELECT count(DISTINCT t.conversation_id)::int FROM conversation_turns t
      WHERE t.user_id = m.user_id AND t.material_context->'sources' @> jsonb_build_array(jsonb_build_object('id', 'material:' || m.id))
    ) AS conversations
    FROM materials m WHERE m.user_id = $1 AND m.deleted_at IS NULL ORDER BY m.created_at DESC, m.id
  `, [userId]);
  return { materials: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })) };
}

// Deleting a material removes everything that still shows its words: the text, the name and opening kept in
// discussion snapshots, replies written from it, and reviews built on it. The row stays, without its content,
// so a repeated delete is recognized.
async function deleteMaterial(db: PoolClient, userId: string, materialId: string) {
  const { rows: [material] } = await db.query<{ deleted: boolean }>(`
    SELECT deleted_at IS NOT NULL AS deleted FROM materials WHERE user_id = $1 AND id = $2 FOR UPDATE
  `, [userId, materialId]);
  if (!material) return false;
  if (material.deleted) return true;
  const params = [userId, materialSourceId(materialId)];
  await db.query(`
    UPDATE conversation_turns t SET reply_blocks = (
      SELECT jsonb_agg(jsonb_build_object('kind', 'unavailable', 'id', block->>'id') ORDER BY position)
      FROM jsonb_array_elements(t.reply_blocks) WITH ORDINALITY AS b(block, position)
    ) WHERE user_id = $1 AND ${readsMaterial} AND reply_blocks IS NOT NULL
  `, params);
  await db.query(`
    UPDATE conversation_turns t SET material_context = jsonb_set(material_context, '{sources}', (
      SELECT jsonb_agg(CASE WHEN source->>'id' = $2
        THEN jsonb_build_object('id', $2::text, 'label', '', 'length', 0, 'preview', '', 'deleted', true) ELSE source END ORDER BY position)
      FROM jsonb_array_elements(t.material_context->'sources') WITH ORDINALITY AS s(source, position)
    )) WHERE user_id = $1 AND ${readsMaterial}
  `, params);
  await db.query(`DELETE FROM review_invitations WHERE user_id = $1 AND proposal->'source'->>'id' = $2`, params);
  await db.query(`
    UPDATE materials SET text = NULL, fingerprint = NULL, label = '', length = 0, deleted_at = clock_timestamp()
    WHERE user_id = $1 AND id = $2
  `, [userId, materialId]);
  return true;
}

export function createMaterialLibrary(pool: Pool) {
  return {
    read: (userId: string) => readMaterialLibrary(pool, userId),
    delete: (userId: string, materialId: string) => inTransaction(pool, async db => {
      await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      return await deleteMaterial(db, userId, materialId) ? readMaterialLibrary(db, userId) : null;
    }),
  };
}
