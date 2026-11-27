import { z } from "zod";
import type { AgentSettings } from "../contracts/agent-settings.js";
import type { ConversationCitation, ConversationContentDraft, ConversationProgress, ConversationSource, UserConversationTurn } from "../contracts/conversation.js";
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
const explanationSchema = z.strictObject({
  blocks: z.array(z.discriminatedUnion("kind", [z.strictObject({
    kind: z.literal("text"),
    text: z.string().trim().min(1).max(800).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text)),
    citations: z.array(referenceSchema).min(1).max(8),
  }), z.strictObject({ kind: z.literal("excerpt"), source: referenceSchema })])).min(1).max(6),
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

function verifiedExplanation(blocks: z.infer<typeof explanationSchema>["blocks"], sources: ConversationSource[]): MaterialExplanation | null {
  const replyBlocks: ConversationContentDraft[] = [];
  for (const block of blocks) {
    if (block.kind === "excerpt") {
      const source = verifyCitation(block.source, sources);
      if (!source) return null;
      replyBlocks.push({ kind: "excerpt", source });
      continue;
    }
    const citations: ConversationCitation[] = [];
    for (const match of block.text.matchAll(/“([^”]+)”|"([^"]+)"/gu)) {
      if (!sources.some(source => source.text.includes(match[1] ?? match[2]))) return null;
    }
    for (const reference of block.citations) {
      const citation = verifyCitation(reference, sources);
      if (!citation) return null;
      if (!citations.some(item => item.sourceId === citation.sourceId && item.quote === citation.quote)) citations.push(citation);
    }
    replyBlocks.push({ kind: "text", text: block.text, citations });
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
