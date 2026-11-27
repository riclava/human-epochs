import type { Pool, PoolClient } from "pg";
import {
  materialPreviewLimit, materialSourceLimit, materialTextLimit, type ConversationMaterialContext, type ConversationMaterialSelection,
  type ConversationSource, type MaterialSourceView,
} from "../../contracts/conversation.js";
import { publishedDiscussions } from "../../courses/catalog.js";

// A turn's saved material. Course sources are short and published with the course, so they keep their text.
// A source the user attached lives once in `materials`; turns keep its ID, name, length and opening.
export type StoredSource = ConversationSource | { id: string; label: string; length: number; preview: string };
export interface StoredMaterialContext {
  discussionVersion: string | null;
  discussionId: string;
  sources: StoredSource[];
}
type NewMaterial = { sourceId: string; label: string; text: string };

const sourceLength = (source: StoredSource) => "text" in source ? source.text.length : source.length;
const opening = (text: string) => text.slice(0, materialPreviewLimit);

export function materialView(context: StoredMaterialContext): ConversationMaterialContext {
  return {
    ...context,
    sources: context.sources.map((source): MaterialSourceView => {
      const length = sourceLength(source);
      const preview = "text" in source ? opening(source.text) : source.preview;
      return { id: source.id, label: source.label, length, preview, truncated: preview.length < length };
    }),
  };
}

// Reads the full text of every source in a saved context, for the model and for verifying its citations.
export async function loadMaterialSources(db: Pool | PoolClient, userId: string, context: StoredMaterialContext): Promise<ConversationSource[]> {
  const ids = context.sources.filter(source => !("text" in source)).map(source => source.id);
  const { rows } = ids.length ? await db.query<{ id: string; text: string }>(
    "SELECT source_id AS id, text FROM materials WHERE user_id = $1 AND source_id = ANY($2::text[])", [userId, ids],
  ) : { rows: [] };
  const texts = new Map(rows.map(row => [row.id, row.text]));
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

// Works out the sources a new turn reads. A newly attached source is returned separately: it is saved once the
// turn exists, because the material belongs to that turn.
export async function resolveMaterialContext(
  db: PoolClient, userId: string, conversationId: string, requestId: string, selection: ConversationMaterialSelection,
): Promise<{ context: StoredMaterialContext; material?: NewMaterial } | null> {
  let parent: StoredMaterialContext | undefined;
  if (selection.parentRequestId) {
    // A follow-up continues a discussion in its own conversation only.
    parent = await readPublishedMaterialContext(db, userId, selection.parentRequestId, conversationId);
    if (!parent || (selection.discussionVersion && selection.discussionVersion !== parent.discussionVersion)) return null;
  }
  const discussionVersion = selection.discussionVersion ?? parent?.discussionVersion ?? null;
  const publication = publishedDiscussions.find(item => item.discussionVersion === discussionVersion);
  if (discussionVersion && !publication) return null;
  const sources: StoredSource[] = [...(parent?.sources ?? publication?.sources ?? [])];
  for (const id of selection.sourceIds ?? []) {
    const source = publication && [...publication.sources, ...publication.supplements].find(item => item.id === id);
    if (!source) return null;
    if (!sources.some(existing => existing.id === id)) sources.push(source);
  }
  const material = selection.excerpt && { sourceId: "excerpt:" + requestId, ...selection.excerpt };
  if (material) sources.push({ id: material.sourceId, label: material.label, length: material.text.length, preview: opening(material.text) });
  if (!sources.length || sources.length > materialSourceLimit
    || sources.reduce((size, source) => size + sourceLength(source), 0) > materialTextLimit) return null;
  return { context: { discussionVersion, discussionId: parent?.discussionId ?? requestId, sources }, ...(material ? { material } : {}) };
}

export async function saveMaterial(db: PoolClient, userId: string, requestId: string, material: NewMaterial) {
  await db.query(`
    INSERT INTO materials (user_id, source_id, request_id, label, text) VALUES ($1, $2, $3, $4, $5)
  `, [userId, material.sourceId, requestId, material.label, material.text]);
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
