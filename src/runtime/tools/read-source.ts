import { z } from "zod";
import type { ConversationSource } from "../../contracts/conversation.js";
import type { ReadOnlyTool } from "../model-loop.js";
import { relevanceTokens } from "../text-relevance.js";

export const sourcePartSize = 3000;
const searchResultLimit = 5;
const passageSize = 600;

// Splits text into parts of about `sourcePartSize` characters at paragraph breaks. A paragraph longer than a part
// is cut at the size limit.
export function sourceParts(text: string) {
  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/(?<=\n)/u)) {
    for (let offset = 0; offset < paragraph.length; offset += sourcePartSize) {
      const piece = paragraph.slice(offset, offset + sourcePartSize);
      if (current && current.length + piece.length > sourcePartSize) {
        parts.push(current);
        current = "";
      }
      current += piece;
    }
  }
  if (current.trim()) parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

const readInput = z.strictObject({ sourceId: z.string().min(1), part: z.int().min(1).optional() });
const searchInput = z.strictObject({ query: z.string().trim().min(1).max(200), sourceId: z.string().min(1).optional() });
const readDefinition = {
  name: "read_source",
  description: "按来源目录中的 ID 和段号读取一段原文（段号从 1 开始，省略时读第 1 段）。引文只能出自读到的段落。",
  parameters: z.toJSONSchema(readInput),
};
const searchDefinition = {
  name: "search_source",
  description: "用问题里的关键词在原文中查找最相关的几段，返回来源 ID、段号和命中位置附近的原文（至多 600 字）。返回的原文可以直接逐字引用；需要更完整的上下文时，用 read_source 读取该段。",
  parameters: z.toJSONSchema(searchInput),
};

export function sourceCatalog(sources: ConversationSource[]) {
  return sources.map(({ id, label, text }) => ({ id, label, length: text.length, parts: sourceParts(text).length }));
}

// Reads and searches the sources of this turn. Only parts that read_source returned count as read, so citations
// are checked against exactly what the model saw.
export function createSourceReader(sources: ConversationSource[]) {
  const parts = new Map(sources.map(source => [source.id, sourceParts(source.text)]));
  const read = new Map<string, { part: number; text: string; callId: string }[]>();
  const passages = new Map<string, string[]>();
  const readTool: ReadOnlyTool = {
    definition: readDefinition,
    execute(input, callId) {
      const args = readInput.safeParse(input);
      if (!args.success) return { outcome: "invalid_input", output: { error: "请提供来源目录中的 ID，段号为正整数。" } };
      const source = sources.find(item => item.id === args.data.sourceId);
      if (!source) return { outcome: "denied", output: { error: "请使用本轮来源目录中的 ID。" } };
      const all = parts.get(source.id)!;
      const part = args.data.part ?? 1;
      if (part > all.length) return { outcome: "invalid_input", output: { error: `这份原文只有 ${all.length} 段。` } };
      const earlier = read.get(source.id) ?? [];
      const previous = earlier.find(entry => entry.part === part);
      if (previous) return { outcome: "returned", output: { id: source.id, part, previousToolCallId: previous.callId } };
      read.set(source.id, [...earlier, { part, text: all[part - 1]!, callId }]);
      return { outcome: "returned", output: { id: source.id, label: source.label, part, parts: all.length, text: all[part - 1]! } };
    },
  };
  const searchTool: ReadOnlyTool = {
    definition: searchDefinition,
    execute(input) {
      const args = searchInput.safeParse(input);
      if (!args.success) return { outcome: "invalid_input", output: { error: "请提供 1 至 200 字的查找内容。" } };
      if (args.data.sourceId && !parts.has(args.data.sourceId)) return { outcome: "denied", output: { error: "请使用本轮来源目录中的 ID。" } };
      const asked = relevanceTokens(args.data.query);
      const results = sources.filter(source => !args.data.sourceId || source.id === args.data.sourceId).flatMap(source =>
        parts.get(source.id)!.map((text, index) => ({ source, part: index + 1, text, score: overlap(asked, text) })))
        .filter(result => result.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, searchResultLimit)
        .map(({ source, part, text }) => {
          const passage = bestPassage(asked, text);
          // A passage the search returns has been seen by the model, so it may be quoted like a part it read.
          passages.set(source.id, [...passages.get(source.id) ?? [], passage]);
          return { sourceId: source.id, label: source.label, part, text: passage };
        });
      return { outcome: "returned", output: { results } };
    },
  };
  return {
    tools: [readTool, searchTool],
    // What the model saw, per source: parts it read in order, then passages search returned. Citations and review
    // evidence are checked against this text.
    readSources: (): ConversationSource[] => sources.flatMap(source => {
      const entries = [...read.get(source.id) ?? []].sort((a, b) => a.part - b.part).map(entry => entry.text);
      const seen = [...entries, ...(passages.get(source.id) ?? []).filter(passage => !entries.some(text => text.includes(passage)))];
      return seen.length ? [{ id: source.id, label: source.label, text: seen.join("\n\n") }] : [];
    }),
  };
}

function overlap(asked: Set<string>, text: string) {
  let score = 0;
  for (const token of relevanceTokens(text)) if (asked.has(token)) score++;
  return score;
}

// The sentences around the best-matching sentence of a part, up to `passageSize` characters. The passage is an exact
// slice of the part, so a quote from it matches the source word for word.
function bestPassage(asked: Set<string>, text: string) {
  const spans = Array.from(text.matchAll(/[^。！？.!?\n]*(?:[。！？.!?]+|\n|$)/gu), match => ({ start: match.index, end: match.index + match[0].length }))
    .filter(span => text.slice(span.start, span.end).trim());
  if (!spans.length) return text.slice(0, passageSize).trim();
  let best = 0;
  spans.forEach((span, index) => {
    if (overlap(asked, text.slice(span.start, span.end)) > overlap(asked, text.slice(spans[best]!.start, spans[best]!.end))) best = index;
  });
  let first = best;
  let last = best;
  const size = (from: number, to: number) => spans[to]!.end - spans[from]!.start;
  while (true) {
    if (last + 1 < spans.length && size(first, last + 1) <= passageSize) last++;
    else if (first > 0 && size(first - 1, last) <= passageSize) first--;
    else break;
  }
  return text.slice(spans[first]!.start, Math.min(spans[last]!.end, spans[first]!.start + passageSize)).trim();
}
