import { conversationContentDraftSchema, type ConversationContentDraft } from "../contracts/conversation.js";

export const structuredFenceKinds = ["event_log", "diagram"] as const;
export const structuredBlockLimit = 3;

// A fence opens at the start of a line with ``` and a structured kind, and closes at the next line that is only ```.
const fence = /^```(event_log|diagram)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gmu;

function parseStructured(kind: string, body: string): ConversationContentDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Ordinary conversation has no readable source, so any citations the model invents are dropped.
  const { citations: _citations, kind: _kind, ...fields } = value as Record<string, unknown>;
  const parsed = conversationContentDraftSchema.safeParse({ ...fields, kind });
  return parsed.success && parsed.data.kind === kind ? parsed.data : null;
}

// Splits a Markdown reply at structured fences. Valid fences become event log or diagram blocks in place; an invalid
// fence stays in the text as an ordinary code block, so a malformed view never fails the reply.
export function splitConversationReply(reply: string): ConversationContentDraft[] {
  const blocks: ConversationContentDraft[] = [];
  let text = "";
  let cursor = 0;
  let structured = 0;
  const flush = () => {
    const trimmed = text.trim();
    if (trimmed) blocks.push({ kind: "text", text: trimmed });
    text = "";
  };
  for (const match of reply.matchAll(fence)) {
    text += reply.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const block = structured < structuredBlockLimit ? parseStructured(match[1]!, match[2]!) : null;
    if (!block) {
      text += match[0];
      continue;
    }
    structured++;
    flush();
    blocks.push(block);
  }
  text += reply.slice(cursor);
  flush();
  return blocks;
}
