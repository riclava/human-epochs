import type { PoolClient } from "pg";
import {
  materialSourceLimit, materialTextLimit, type ConversationMaterialContext, type ConversationMaterialSelection,
} from "../../contracts/conversation.js";
import { publishedDiscussions } from "../../courses/catalog.js";

// Without a conversation ID this reads any of the user's published discussions, as activity hand-off does.
export async function readPublishedMaterialContext(db: PoolClient, userId: string, requestId: string, conversationId?: string) {
  const result = await db.query<{ materialContext: ConversationMaterialContext }>(`
    SELECT material_context AS "materialContext" FROM conversation_turns
    WHERE user_id = $1 AND request_id = $2 AND status = 'complete' AND material_context IS NOT NULL
      AND ($3::uuid IS NULL OR conversation_id = $3)
  `, [userId, requestId, conversationId ?? null]);
  return result.rows[0]?.materialContext;
}

export async function resolveMaterialContext(
  db: PoolClient, userId: string, conversationId: string, requestId: string, selection: ConversationMaterialSelection,
): Promise<ConversationMaterialContext | null> {
  let parent: ConversationMaterialContext | undefined;
  if (selection.parentRequestId) {
    // A follow-up continues a discussion in its own conversation only.
    parent = await readPublishedMaterialContext(db, userId, selection.parentRequestId, conversationId);
    if (!parent || (selection.discussionVersion && selection.discussionVersion !== parent.discussionVersion)) return null;
  }
  const discussionVersion = selection.discussionVersion ?? parent?.discussionVersion ?? null;
  const publication = publishedDiscussions.find(item => item.discussionVersion === discussionVersion);
  if (discussionVersion && !publication) return null;
  const sources = [...(parent?.sources ?? publication?.sources ?? [])];
  for (const id of selection.sourceIds ?? []) {
    const source = publication && [...publication.sources, ...publication.supplements].find(item => item.id === id);
    if (!source) return null;
    if (!sources.some(existing => existing.id === id)) sources.push(source);
  }
  if (selection.excerpt) sources.push({ ...selection.excerpt, id: "excerpt:" + requestId });
  if (!sources.length || sources.length > materialSourceLimit
    || sources.reduce((size, source) => size + source.text.length, 0) > materialTextLimit) return null;
  return { discussionVersion, discussionId: parent?.discussionId ?? requestId, sources };
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
