import type { ConversationMessage } from "./model.js";

export function limitModelHistory(history: ConversationMessage[], historyByteLimit: number): ConversationMessage[] {
  let start = history.length;
  let remaining = historyByteLimit - 2; // JSON array brackets
  while (start > 0) {
    const hasReply = history[start - 1]?.role === "assistant" && history[start - 2]?.role === "user";
    const turnStart = start - (hasReply ? 2 : 1);
    const separator = start < history.length ? 1 : 0;
    const size = Buffer.byteLength(JSON.stringify(history.slice(turnStart, start))) - 2 + separator;
    if (size > remaining) break;
    remaining -= size;
    start = turnStart;
  }
  return history.slice(start);
}
