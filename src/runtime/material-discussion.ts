import { z } from "zod";
import type { AgentSettings } from "../contracts/agent-settings.js";
import {
  conversationContentDraftSchema, type ConversationCitation, type ConversationContentDraft, type ConversationProgress,
  type ConversationSource, type UserConversationTurn,
} from "../contracts/conversation.js";
import { reviewProposal, type ReviewProposal } from "../review/proposal.js";
import type { ObserveRun } from "./diagnostics.js";
import { runMaterialModel } from "./material-model.js";
import type { CallModel, MaterialPrompt } from "./model.js";

export interface MaterialExplanation {
  replyBlocks: ConversationContentDraft[];
  explanationSource?: UserConversationTurn["explanationSource"];
  review?: ReviewProposal;
}

export interface MaterialPublication {
  question: string;
  sources: ConversationSource[];
  supplements: ConversationSource[];
  readings?: { text: string; sourceIds: string[] }[];
}

const referenceSchema = z.strictObject({ sourceId: z.string(), quote: z.string().trim().min(1).max(1200) });
const citationsSchema = z.array(referenceSchema).min(1).max(8);
// Structured blocks may carry their citations on items instead; the shared contract still requires at least one.
const blockCitationsSchema = z.array(referenceSchema).max(8).default([]);
const explanationSchema = z.strictObject({
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
});
const otherTopicSchema = z.strictObject({
  otherTopic: z.string().trim().min(1).max(4000).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text)),
});

function verifyCitation(reference: z.infer<typeof referenceSchema>, sources: ConversationSource[]): ConversationCitation | null {
  const source = sources.find(item => item.id === reference.sourceId);
  return source?.text.includes(reference.quote) ? { sourceId: source.id, label: source.label, quote: reference.quote } : null;
}

// Text in Chinese or straight quotation marks claims to be quoted, so it must appear in a readable source.
function quotesAreSourced(text: string, sources: ConversationSource[]) {
  return Array.from(text.matchAll(/“([^”]+)”|"([^"]+)"/gu))
    .every(match => sources.some(source => source.text.includes(match[1] ?? match[2]!)));
}

function verifyCitations(references: z.infer<typeof citationsSchema>, sources: ConversationSource[]) {
  const citations: ConversationCitation[] = [];
  for (const reference of references) {
    const citation = verifyCitation(reference, sources);
    if (!citation) return null;
    if (!citations.some(item => item.sourceId === citation.sourceId && item.quote === citation.quote)) citations.push(citation);
  }
  return citations;
}

function verifiedBlock(block: z.infer<typeof explanationSchema>["blocks"][number], sources: ConversationSource[]): ConversationContentDraft | null {
  if (block.kind === "excerpt") {
    const source = verifyCitation(block.source, sources);
    return source && { kind: "excerpt", source };
  }
  if (block.kind === "text") {
    const citations = verifyCitations(block.citations, sources);
    return citations && quotesAreSourced(block.text, sources) ? { kind: "text", text: block.text, citations } : null;
  }
  const { block: flat, references } = hoistCitations(block);
  const nested = z.array(referenceSchema).max(16).safeParse(references);
  const citations = nested.success && verifyCitations([...block.citations, ...nested.data], sources);
  // Every structured view in a material explanation needs at least one verified citation.
  if (!citations || !citations.length) return null;
  const parsed = conversationContentDraftSchema.safeParse({ ...flat, citations });
  if (!parsed.success || parsed.data.kind !== block.kind) return null;
  return structuredTexts(parsed.data).every(text => quotesAreSourced(text, sources)) ? parsed.data : null;
}

type StructuredDraft = Extract<z.infer<typeof explanationSchema>["blocks"][number], { kind: "event_log" | "diagram" }>;

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

function verifiedExplanation(blocks: z.infer<typeof explanationSchema>["blocks"], sources: ConversationSource[]): MaterialExplanation | null {
  const replyBlocks: ConversationContentDraft[] = [];
  for (const block of blocks) {
    const verified = verifiedBlock(block, sources);
    if (!verified) return null;
    replyBlocks.push(verified);
  }
  return { replyBlocks, explanationSource: "model" };
}

function quotePassages(sources: ConversationSource[], question: string): MaterialExplanation {
  const terms = new Set(question.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
  const pairs = Array.from(question.matchAll(/(?=([\p{Script=Han}]{2}))/gu), match => match[1]);
  for (const pair of pairs) terms.add(pair);
  const candidates = [...sources].reverse().flatMap(source => source.text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/u).map(quote => ({
    sourceId: source.id, label: source.label, quote: quote.trim(),
    relevance: Array.from(terms).filter(term => quote.toLowerCase().includes(term)).length,
  }))).filter(candidate => candidate.quote.length > 0);
  candidates.sort((a, b) => b.relevance - a.relevance);
  const best = candidates[0]!;
  const citations = candidates.filter(candidate => candidate.relevance === best.relevance).slice(0, 2)
    .map(({ sourceId, label, quote }) => ({ sourceId, label, quote: Array.from(quote).slice(0, 400).join("") }));
  return {
    replyBlocks: [
      { kind: "text", text: best.relevance ? "下面是和问题相关的引文，可以按来源核对原文。" : "我摘出了原文供你核对。要判断原文以外的情况，还需要更多证据。" },
      ...citations.map(source => ({ kind: "excerpt" as const, source })),
    ],
    explanationSource: "excerpt",
  };
}

export async function discussMaterial(
  publication: MaterialPublication | undefined, prompt: MaterialPrompt, callModel: CallModel | null,
  settings: Readonly<AgentSettings>, options: { observe?: ObserveRun; signal?: AbortSignal; onProgress?: (progress: ConversationProgress) => void },
): Promise<MaterialExplanation> {
  let reason: "model_unavailable" | "model_failed" | "invalid_output" | "invalid_citation" = "model_unavailable";
  if (callModel) {
    reason = "model_failed";
    try {
      const answer = await runMaterialModel(prompt, callModel, settings, options.observe, options.onProgress);
      options.onProgress?.("checking_citations");
      reason = "invalid_output";
      const value: unknown = JSON.parse(answer.text);
      const other = prompt.review && otherTopicSchema.safeParse(value);
      if (other?.success) return { replyBlocks: [{ kind: "text", text: other.data.otherTopic }] };
      const parsed = explanationSchema.safeParse(value);
      if (parsed.success) {
        const explanation = verifiedExplanation(parsed.data.blocks, answer.sources);
        if (explanation) {
          const mayOffer = prompt.offerReview && (!prompt.review || parsed.data.reviewAnswered === true);
          const review = mayOffer ? reviewProposal(parsed.data.review, answer.sources) : undefined;
          return review && review.question !== prompt.review?.question ? { ...explanation, review } : explanation;
        }
        reason = "invalid_citation";
      }
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  options.observe?.({ event: "material_fallback", reason });
  const { question, sources } = prompt;
  const published = publication ? [...publication.sources, ...publication.supplements] : [];
  // A guide applies only to the evidence it was written for. User-added sources can contradict it.
  const reading = publication?.readings?.find(item => {
    const passages = item.sourceIds.map(id => published.find(source => source.id === id)?.text);
    return passages.length > 0 && passages.every(text => sources.some(source => source.text === text))
      && sources.every(source => passages.includes(source.text));
  });
  const opening = publication?.question.replace(/[？?。！!\s]+/gu, "");
  const revisitingEvidence = /(?:能|可以)确定什么|说明了?什么|改变.{0,4}判断|重新判断/u.test(question);
  if (reading && (question.replace(/[？?。！!\s]+/gu, "") === opening || revisitingEvidence)) {
    const citations = sources.map(source => ({ sourceId: source.id, label: source.label, quote: source.text }));
    return { replyBlocks: [{ kind: "text", text: reading.text, citations }], explanationSource: "course" };
  }
  return quotePassages(sources, question);
}
