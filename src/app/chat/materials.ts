import type { PoolClient } from "pg";
import type { ChatMaterialContext, ChatMaterialInput } from "../../contracts/chat.js";
import { publishedDiscussions } from "../../curriculum/catalog.js";

export async function readPublishedMaterial(db: PoolClient, learnerId: string, requestId: string) {
  const result = await db.query<{ context: ChatMaterialContext }>(`
    SELECT material_context AS context FROM chat_turns
    WHERE learner_id = $1 AND request_id = $2 AND status = 'complete' AND material_context IS NOT NULL
  `, [learnerId, requestId]);
  return result.rows[0]?.context;
}

export async function materialContext(
  db: PoolClient, learnerId: string, requestId: string, command: ChatMaterialInput,
): Promise<ChatMaterialContext | null> {
  let parent: ChatMaterialContext | undefined;
  if (command.parentRequestId) {
    parent = await readPublishedMaterial(db, learnerId, command.parentRequestId);
    if (!parent || (command.version && command.version !== parent.version)) return null;
  }
  const version = command.version ?? parent?.version ?? null;
  const publication = publishedDiscussions.find(item => item.version === version);
  if (version && !publication) return null;
  const sources = [...(parent?.sources ?? publication?.sources ?? [])];
  for (const id of command.sourceIds ?? []) {
    const source = publication && [...publication.sources, ...publication.supplements].find(item => item.id === id);
    if (!source) return null;
    if (!sources.some(existing => existing.id === id)) sources.push(source);
  }
  if (command.excerpt) sources.push({ ...command.excerpt, id: "excerpt:" + requestId });
  if (!sources.length || sources.length > 16 || sources.reduce((size, source) => size + source.text.length, 0) > 32000) return null;
  return { version, discussionId: parent?.discussionId ?? requestId, sources };
}

export function listMaterials() {
  return { materials: publishedDiscussions.map(({ version, title, question, sources, supplements }) => ({
    version, title, question, sources, supplements,
  })) };
}
