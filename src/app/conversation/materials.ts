import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  materialPreviewLimit, materialSourceLimit, materialTextLimit, type ConversationMaterialContext, type ConversationMaterialSelection,
  type ConversationSource, type MaterialSourceView,
} from "../../contracts/conversation.js";
import { publishedDiscussions } from "../../courses/catalog.js";

// A turn's saved material. Course sources are short and published with the course, so they keep their text.
// A material the user attached lives once in `materials`; turns keep its ID, name, length and opening. A deleted
// material keeps only its ID.
export type StoredSource = ConversationSource | { id: string; label: string; length: number; preview: string; deleted?: true };
export interface StoredMaterialContext {
  discussionVersion: string | null;
  discussionId: string;
  sources: StoredSource[];
}

export const materialSourceId = (materialId: string) => "material:" + materialId;
const materialIdOf = (sourceId: string) => sourceId.startsWith("material:") ? sourceId.slice("material:".length) : null;
const sourceLength = (source: StoredSource) => "text" in source ? source.text.length : source.length;
const opening = (text: string) => text.slice(0, materialPreviewLimit);
const fingerprintOf = (text: string) => createHash("sha256").update(text).digest("hex");

export function materialView(context: StoredMaterialContext): ConversationMaterialContext {
  return {
    ...context,
    sources: context.sources.map((source): MaterialSourceView => {
      if (!("text" in source) && source.deleted) {
        return { id: source.id, label: "已删除的材料", length: 0, preview: "", truncated: false, deleted: true };
      }
      const length = sourceLength(source);
      const preview = "text" in source ? opening(source.text) : source.preview;
      return { id: source.id, label: source.label, length, preview, truncated: preview.length < length, deleted: false };
    }),
  };
}

// Reads the full text of every source in a saved context, for the model and for verifying its citations.
// A deleted material is left out.
export async function loadMaterialSources(db: Pool | PoolClient, userId: string, context: StoredMaterialContext): Promise<ConversationSource[]> {
  const ids = context.sources.flatMap(source => "text" in source ? [] : [materialIdOf(source.id)].filter(id => id !== null));
  const { rows } = ids.length ? await db.query<{ id: string; text: string }>(`
    SELECT id, text FROM materials WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
  `, [userId, ids]) : { rows: [] };
  const texts = new Map(rows.map(row => [materialSourceId(row.id), row.text]));
  return context.sources.map(source => "text" in source ? source : { id: source.id, label: source.label, text: texts.get(source.id) ?? "" })
    .filter(source => source.text);
}

// Without a conversation ID this reads any of the user's published discussions, as activity hand-off does.
export async function readPublishedMaterialContext(db: PoolClient, userId: string, requestId: string, conversationId?: string) {
  const result = await db.query<{ materialContext: StoredMaterialContext }>(`
    SELECT material_context AS "materialContext" FROM conversation_turns
    WHERE user_id = $1 AND request_id = $2 AND status = 'complete' AND material_context IS NOT NULL
      AND ($3::uuid IS NULL OR conversation_id = $3)
  `, [userId, requestId, conversationId ?? null]);
  return result.rows[0]?.materialContext;
}

// Works out the sources a new turn reads. Chosen library materials join by reference; a newly attached text joins
// the user's library, reusing an identical material. Nothing is stored until the sources pass the limits.
export async function resolveMaterialContext(
  db: PoolClient, userId: string, conversationId: string, requestId: string, selection: ConversationMaterialSelection,
): Promise<StoredMaterialContext | null> {
  let parent: StoredMaterialContext | undefined;
  if (selection.parentRequestId) {
    // A follow-up continues a discussion in its own conversation only.
    parent = await readPublishedMaterialContext(db, userId, selection.parentRequestId, conversationId);
    if (!parent || (selection.discussionVersion && selection.discussionVersion !== parent.discussionVersion)) return null;
  }
  const discussionVersion = selection.discussionVersion ?? parent?.discussionVersion ?? null;
  const publication = publishedDiscussions.find(item => item.discussionVersion === discussionVersion);
  if (discussionVersion && !publication) return null;
  // A deleted material cannot be read again, so a continued discussion leaves it behind.
  const sources: StoredSource[] = [...(parent?.sources ?? publication?.sources ?? [])].filter(source => "text" in source || !source.deleted);
  const add = (source: StoredSource) => { if (!sources.some(existing => existing.id === source.id)) sources.push(source); };
  for (const id of selection.sourceIds ?? []) {
    const source = publication && [...publication.sources, ...publication.supplements].find(item => item.id === id);
    if (!source) return null;
    add(source);
  }
  const chosen = [...new Set(selection.materialIds ?? [])];
  if (chosen.length) {
    const { rows } = await db.query<{ id: string; label: string; length: number; opening: string }>(`
      SELECT id, label, length, left(text, $3) AS opening FROM materials
      WHERE user_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL
    `, [userId, chosen, materialPreviewLimit]);
    if (rows.length !== chosen.length) return null;
    for (const id of chosen) {
      const row = rows.find(item => item.id === id)!;
      add({ id: materialSourceId(row.id), label: row.label, length: row.length, preview: row.opening });
    }
  }
  const existing = selection.excerpt && await findMaterial(db, userId, selection.excerpt.text);
  if (selection.excerpt) {
    const { label, text } = selection.excerpt;
    add({ id: materialSourceId(existing?.id ?? requestId), label: existing?.label ?? label, length: text.length, preview: opening(text) });
  }
  if (!sources.length || sources.length > materialSourceLimit
    || sources.reduce((size, source) => size + sourceLength(source), 0) > materialTextLimit) return null;
  if (selection.excerpt && !existing) await storeMaterial(db, userId, requestId, selection.excerpt);
  return { discussionVersion, discussionId: parent?.discussionId ?? requestId, sources };
}

async function findMaterial(db: PoolClient, userId: string, text: string) {
  const { rows: [material] } = await db.query<{ id: string; label: string }>(`
    SELECT id, label FROM materials WHERE user_id = $1 AND fingerprint = $2 AND deleted_at IS NULL
  `, [userId, fingerprintOf(text)]);
  return material;
}

// A new material takes the ID of the turn that first attached it, so a retried send cannot store it twice.
async function storeMaterial(db: PoolClient, userId: string, requestId: string, excerpt: { label: string; text: string }) {
  await db.query(`
    INSERT INTO materials (user_id, id, label, text, length, fingerprint) VALUES ($1, $2, $3, $4, $5, $6)
  `, [userId, requestId, excerpt.label, excerpt.text, excerpt.text.length, fingerprintOf(excerpt.text)]);
}

export function listMaterials() {
  return { materials: publishedDiscussions.map(({ discussionVersion, title, question, sources, supplements }) => ({
    discussionVersion, title, question, sources, supplements,
  })) };
}

export function namedMaterial(text: string): ConversationMaterialSelection | undefined {
  const selected = publishedDiscussions.filter(item => text.includes(item.title));
  if (selected.length === 1) return { discussionVersion: selected[0]!.discussionVersion };
}
