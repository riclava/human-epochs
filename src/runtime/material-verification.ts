import { z } from "zod";
import {
  conversationContentDraftSchema, diagramProblem, eventLogProblem, type ConversationCitation, type ConversationContentDraft,
  type ConversationSource,
} from "../contracts/conversation.js";
import type { VerificationFailure } from "./diagnostics.js";

export const referenceSchema = z.strictObject({ sourceId: z.string(), quote: z.string().trim().min(1).max(1200) });
const citationsSchema = z.array(referenceSchema).min(1).max(8);
// Structured blocks may carry their citations on items instead; the shared contract still requires at least one.
const blockCitationsSchema = z.array(referenceSchema).max(8).default([]);
export const explanationSchema = z.strictObject({
  blocks: z.array(z.discriminatedUnion("kind", [z.strictObject({
    kind: z.literal("text"),
    text: z.string().trim().min(1).max(800).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text)),
    citations: citationsSchema,
  }), z.strictObject({ kind: z.literal("excerpt"), source: referenceSchema }),
  // Structure is checked by the shared contract after citations are verified.
  z.strictObject({
    kind: z.literal("event_log"), title: z.string(), view: z.string(),
    participants: z.array(z.unknown()), events: z.array(z.unknown()), citations: blockCitationsSchema,
  }), z.strictObject({
    kind: z.literal("diagram"), title: z.string(), nodes: z.array(z.unknown()), edges: z.array(z.unknown()), citations: blockCitationsSchema,
  })])).min(1).max(6),
  review: z.unknown().optional(),
  reviewAnswered: z.unknown().optional(),
  reviewOutcome: z.unknown().optional(),
});
type ReplyBlock = z.infer<typeof explanationSchema>["blocks"][number];
type StructuredDraft = Extract<ReplyBlock, { kind: "event_log" | "diagram" }>;

// What failed, in words the model can act on, and the category kept in logs.
export interface Problem {
  failure: VerificationFailure;
  message: string;
}

const clip = (text: string) => {
  const characters = Array.from(text);
  return characters.length > 40 ? characters.slice(0, 40).join("") + "…" : text;
};

function verifyCitation(reference: z.infer<typeof referenceSchema>, sources: ConversationSource[], problems: Problem[]): ConversationCitation | null {
  const source = sources.find(item => item.id === reference.sourceId);
  if (!source) {
    problems.push({ failure: "invalid_citation", message: `来源 ID「${clip(reference.sourceId)}」不在本轮可读的来源里。` });
    return null;
  }
  if (!source.text.includes(reference.quote)) {
    problems.push({ failure: "invalid_citation", message: `引文「${clip(reference.quote)}」不能在「${source.label}」的原文中逐字找到。` });
    return null;
  }
  return { sourceId: source.id, label: source.label, quote: reference.quote };
}

// Text in Chinese or straight quotation marks claims to be quoted, so it must appear word for word in a readable
// source or in the user's own message, which feedback on an answer may quote back.
function checkQuotes(text: string, quotable: readonly string[], problems: Problem[]) {
  const unsourced = Array.from(text.matchAll(/“([^”]+)”|"([^"]+)"/gu), match => match[1] ?? match[2]!)
    .filter(quote => !quotable.some(passage => passage.includes(quote)));
  for (const quote of unsourced) {
    problems.push({ failure: "unsourced_quote", message: `引号里的「${clip(quote)}」不在原文或用户消息里。概括、强调或你自己的说法不要加引号。` });
  }
  return unsourced.length === 0;
}

function verifyCitations(references: z.infer<typeof citationsSchema>, sources: ConversationSource[], problems: Problem[]) {
  const citations: ConversationCitation[] = [];
  let valid = true;
  for (const reference of references) {
    const citation = verifyCitation(reference, sources, problems);
    if (!citation) { valid = false; continue; }
    if (!citations.some(item => item.sourceId === citation.sourceId && item.quote === citation.quote)) citations.push(citation);
  }
  return valid ? citations : null;
}

// Models sometimes cite each event, node or edge. Those citations move to the block and are verified with the rest.
function hoistCitations(block: StructuredDraft) {
  const references: unknown[] = [];
  const strip = (items: unknown[]) => items.map(item => {
    if (!item || typeof item !== "object" || !("citations" in item)) return item;
    const { citations, ...rest } = item as { citations: unknown };
    if (Array.isArray(citations)) references.push(...citations);
    return rest;
  });
  const flat = block.kind === "event_log"
    ? { ...block, events: strip(block.events) }
    : { ...block, nodes: strip(block.nodes), edges: strip(block.edges) };
  return { block: flat, references };
}

// Every piece of wording a structured view shows is checked like body text.
function structuredTexts(block: ConversationContentDraft): string[] {
  if (block.kind === "event_log") return [block.title, ...block.events.map(event => event.text)];
  if (block.kind === "diagram") {
    return [block.title, ...block.nodes.map(node => node.label), ...block.edges.flatMap(edge => edge.label ? [edge.label] : [])];
  }
  return [];
}

function structureProblem(block: StructuredDraft, parsed: z.ZodSafeParseResult<ConversationContentDraft>) {
  const name = block.kind === "event_log" ? "事件块" : "关系图块";
  const shape = block as unknown as Parameters<typeof eventLogProblem>[0] & Parameters<typeof diagramProblem>[0];
  const reference = Array.isArray(shape.participants ?? shape.nodes) && Array.isArray(shape.events ?? shape.edges)
    ? (block.kind === "event_log" ? eventLogProblem(shape) : diagramProblem(shape)) : null;
  const detail = reference ?? (parsed.success ? "" : parsed.error.issues.slice(0, 2).map(issue => `${issue.path.join(".")}：${issue.message}`).join("；"));
  return `${name}「${clip(block.title)}」结构无效（${detail}）。请对照格式说明修正。`;
}

function verifiedStructured(block: StructuredDraft, sources: ConversationSource[], quotable: readonly string[], problems: Problem[]) {
  const { block: flat, references } = hoistCitations(block);
  const nested = z.array(referenceSchema).max(16).safeParse(references);
  if (!nested.success) problems.push({ failure: "invalid_output", message: "事件、节点或连线上的 citations 格式不对。" });
  const citations = nested.success ? verifyCitations([...block.citations, ...nested.data], sources, problems) : null;
  // Every structured view in a material explanation needs at least one verified citation.
  if (citations && !citations.length) problems.push({ failure: "invalid_citation", message: `「${clip(block.title)}」需要至少一条逐字引文。` });
  const parsed = conversationContentDraftSchema.safeParse({ ...flat, citations: citations?.length ? citations : undefined });
  if (!parsed.success || parsed.data.kind !== block.kind) {
    problems.push({ failure: "invalid_structure", message: structureProblem(block, parsed) });
    return null;
  }
  const quoted = structuredTexts(parsed.data).every(text => checkQuotes(text, quotable, problems));
  return citations?.length && quoted ? parsed.data : null;
}

function verifiedBlock(block: ReplyBlock, sources: ConversationSource[], quotable: readonly string[], problems: Problem[]) {
  if (block.kind === "excerpt") {
    const source = verifyCitation(block.source, sources, problems);
    return source && { kind: "excerpt" as const, source };
  }
  if (block.kind === "text") {
    const citations = verifyCitations(block.citations, sources, problems);
    const quoted = checkQuotes(block.text, quotable, problems);
    return citations && quoted ? { kind: "text" as const, text: block.text, citations } : null;
  }
  return verifiedStructured(block, sources, quotable, problems);
}

// Checks every block and reports all problems at once, so a single revision can fix them together.
export function verifyReplyBlocks(
  blocks: ReplyBlock[], sources: ConversationSource[], userMessage: string,
): { blocks: ConversationContentDraft[] } | { problems: Problem[] } {
  // Citations must come from the sources; quotation marks in the text may also quote the user's message.
  const quotable = [...sources.map(source => source.text), userMessage];
  const problems: Problem[] = [];
  const verified = blocks.map(block => verifiedBlock(block, sources, quotable, problems));
  return problems.length ? { problems } : { blocks: verified.filter(block => block !== null) };
}

// Asks for one corrected reply in the same JSON format, listing what failed.
export function revisionRequest(problems: Problem[]) {
  const lines = problems.slice(0, 6).map(problem => "- " + problem.message);
  return ["上一次的回复没有通过校验：", ...lines,
    "请修正这些问题，按同样的 JSON 格式重新返回完整回复。引文必须逐字出自本轮读到的原文，不要引用其他内容。"].join("\n");
}

export function outputProblem(error: unknown): Problem {
  const detail = error instanceof z.ZodError
    ? error.issues.slice(0, 3).map(issue => `${issue.path.join(".") || "根对象"}：${issue.message}`).join("；")
    : "不是有效的 JSON";
  return { failure: "invalid_output", message: `回复不符合要求的 JSON 结构（${detail}）。` };
}
