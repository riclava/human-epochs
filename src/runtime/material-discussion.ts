import { z } from "zod";
import type { AgentSettings } from "../contracts/agent-settings.js";
import type { ChatCitation, ChatContentDraft, ChatProgress, ChatSource, ChatTurn } from "../contracts/chat.js";
import type { ObserveRun } from "./diagnostics.js";
import { runMaterialModel } from "./material-model.js";
import type { CallModel, MaterialPrompt } from "./model.js";

export interface MaterialExplanation {
  content: ChatContentDraft[];
  mode: NonNullable<ChatTurn["explanationMode"]>;
}

export interface MaterialPublication {
  question: string;
  sources: ChatSource[];
  supplements: ChatSource[];
  readings?: { text: string; sourceIds: string[] }[];
}

const referenceSchema = z.strictObject({ id: z.string(), quote: z.string().trim().min(1).max(1200) });
const explanationSchema = z.strictObject({
  blocks: z.array(z.discriminatedUnion("kind", [z.strictObject({
    kind: z.literal("text"),
    text: z.string().trim().min(1).max(800).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text)),
    citations: z.array(referenceSchema).min(1).max(8),
  }), z.strictObject({ kind: z.literal("excerpt"), source: referenceSchema })])).min(1).max(6),
});

function verifyCitation(reference: z.infer<typeof referenceSchema>, sources: ChatSource[]): ChatCitation | null {
  const source = sources.find(item => item.id === reference.id);
  return source?.text.includes(reference.quote) ? { id: source.id, label: source.label, quote: reference.quote } : null;
}

function verifiedExplanation(blocks: z.infer<typeof explanationSchema>["blocks"], sources: ChatSource[]): MaterialExplanation | null {
  const content: ChatContentDraft[] = [];
  for (const block of blocks) {
    if (block.kind === "excerpt") {
      const source = verifyCitation(block.source, sources);
      if (!source) return null;
      content.push({ kind: "excerpt", source });
      continue;
    }
    const citations: ChatCitation[] = [];
    for (const match of block.text.matchAll(/“([^”]+)”|"([^"]+)"/gu)) {
      if (!sources.some(source => source.text.includes(match[1] ?? match[2]))) return null;
    }
    for (const reference of block.citations) {
      const citation = verifyCitation(reference, sources);
      if (!citation) return null;
      if (!citations.some(item => item.id === citation.id && item.quote === citation.quote)) citations.push(citation);
    }
    content.push({ kind: "text", text: block.text, citations });
  }
  return { content, mode: "model" };
}

function quotePassages(sources: ChatSource[], question: string): MaterialExplanation {
  const terms = new Set(question.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
  const pairs = Array.from(question.matchAll(/(?=([\p{Script=Han}]{2}))/gu), match => match[1]);
  for (const pair of pairs) terms.add(pair);
  const candidates = [...sources].reverse().flatMap(source => source.text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/u).map(quote => ({
    id: source.id, label: source.label, quote: quote.trim(),
    relevance: Array.from(terms).filter(term => quote.toLowerCase().includes(term)).length,
  }))).filter(candidate => candidate.quote.length > 0);
  candidates.sort((a, b) => b.relevance - a.relevance);
  const best = candidates[0]!;
  const citations = candidates.filter(candidate => candidate.relevance === best.relevance).slice(0, 2)
    .map(({ id, label, quote }) => ({ id, label, quote: Array.from(quote).slice(0, 400).join("") }));
  return {
    content: [
      { kind: "text", text: best.relevance ? "下面是和问题相关的原句，可以对照出处核实。" : "我摘出了原文供你核对。要判断原文以外的情况，还需要更多证据。" },
      ...citations.map(source => ({ kind: "excerpt" as const, source })),
    ],
    mode: "excerpt",
  };
}

export async function discussMaterial(
  publication: MaterialPublication | undefined, prompt: MaterialPrompt, callModel: CallModel | null,
  settings: Readonly<AgentSettings>, options: { observe?: ObserveRun; signal?: AbortSignal; onProgress?: (progress: ChatProgress) => void },
): Promise<MaterialExplanation> {
  let reason: "model_unavailable" | "model_failed" | "invalid_output" | "invalid_citation" = "model_unavailable";
  if (callModel) {
    reason = "model_failed";
    try {
      const answer = await runMaterialModel(prompt, callModel, settings, options.observe, options.onProgress);
      options.onProgress?.("checking_citations");
      reason = "invalid_output";
      const parsed = explanationSchema.safeParse(JSON.parse(answer.text));
      if (parsed.success) {
        const explanation = verifiedExplanation(parsed.data.blocks, answer.sources);
        if (explanation) return explanation;
        reason = "invalid_citation";
      }
    } catch {
      options.signal?.throwIfAborted();
    }
  }
  options.observe?.({ event: "material_fallback", reason });
  const { question, sources } = prompt;
  const published = publication ? [...publication.sources, ...publication.supplements] : [];
  // A guide applies only to the evidence it was written for. Learner-added sources can contradict it.
  const reading = publication?.readings?.find(item => {
    const passages = item.sourceIds.map(id => published.find(source => source.id === id)?.text);
    return passages.length > 0 && passages.every(text => sources.some(source => source.text === text))
      && sources.every(source => passages.includes(source.text));
  });
  const opening = publication?.question.replace(/[？?。！!\s]+/gu, "");
  const revisitingEvidence = /(?:能|可以)确定什么|说明了?什么|改变.{0,4}判断|重新判断/u.test(question);
  if (reading && (question.replace(/[？?。！!\s]+/gu, "") === opening || revisitingEvidence)) {
    const citations = sources.map(source => ({ id: source.id, label: source.label, quote: source.text }));
    return { content: [{ kind: "text", text: reading.text, citations }], mode: "course" };
  }
  return quotePassages(sources, question);
}
