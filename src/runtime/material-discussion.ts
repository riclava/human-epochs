import { z } from "zod";
import type { AgentSettings } from "../contracts/agent-settings.js";
import type { ConversationContentDraft, ConversationProgress, ConversationSource, UserConversationTurn } from "../contracts/conversation.js";
import { goalProgressProposalLimit } from "../contracts/learning-goal.js";
import { reviewOutcome, reviewProposal, type ReviewOutcome, type ReviewProposal } from "../review/proposal.js";
import type { ObserveRun, VerificationFailure } from "./diagnostics.js";
import { runMaterialModel } from "./material-model.js";
import { explanationSchema, outputProblem, revisionRequest, verifyReplyBlocks, type Problem } from "./material-verification.js";
import type { CallModel, MaterialPrompt } from "./model.js";

export interface MaterialExplanation {
  replyBlocks: ConversationContentDraft[];
  explanationSource?: UserConversationTurn["explanationSource"];
  review?: ReviewProposal;
  // Set only when the turn answered a review question.
  reviewOutcome?: ReviewOutcome;
  // New progress for the conversation's goal, kept only when the answer was recalled.
  goalProgress?: string;
}

export interface MaterialPublication {
  question: string;
  sources: ConversationSource[];
  supplements: ConversationSource[];
  readings?: { text: string; sourceIds: string[] }[];
}

const goalProgressSchema = z.string().trim().min(1).max(goalProgressProposalLimit).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text));

const otherTopicSchema = z.strictObject({
  otherTopic: z.string().trim().min(1).max(4000).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text)),
});

type Interpretation = { kind: "explained"; explanation: MaterialExplanation } | { kind: "rejected"; problems: Problem[] };

// Turns a model reply into a verified explanation, or into the problems that kept it from being one.
function interpret(text: string, prompt: MaterialPrompt, sources: ConversationSource[]): Interpretation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: "rejected", problems: [outputProblem(error)] };
  }
  const other = prompt.review && otherTopicSchema.safeParse(value);
  if (other?.success) return { kind: "explained", explanation: { replyBlocks: [{ kind: "text", text: other.data.otherTopic }] } };
  const parsed = explanationSchema.safeParse(value);
  if (!parsed.success) return { kind: "rejected", problems: [outputProblem(parsed.error)] };
  const verified = verifyReplyBlocks(parsed.data.blocks, sources, prompt.question);
  if ("problems" in verified) return { kind: "rejected", problems: verified.problems };
  const explanation: MaterialExplanation = { replyBlocks: verified.blocks, explanationSource: "model" };
  const answered = !!prompt.review && parsed.data.reviewAnswered === true;
  const outcome = answered ? reviewOutcome(parsed.data.reviewOutcome) : undefined;
  const mayOffer = prompt.offerReview && (!prompt.review || answered);
  const review = mayOffer ? reviewProposal(parsed.data.review, sources) : undefined;
  // Only an answer recalled in full is evidence enough to suggest new progress; anything malformed is left out.
  const progress = prompt.currentGoal && outcome?.result === "recalled" ? goalProgressSchema.safeParse(parsed.data.goalProgress) : undefined;
  return { kind: "explained", explanation: {
    ...explanation,
    ...(review && review.question !== prompt.review?.question ? { review } : {}),
    ...(outcome ? { reviewOutcome: outcome } : {}),
    ...(progress?.success ? { goalProgress: progress.data } : {}),
  } };
}

// The most frequent category names the failure in logs.
function mainFailure(problems: Problem[]): VerificationFailure {
  const order: VerificationFailure[] = ["invalid_output", "invalid_structure", "invalid_citation", "unsourced_quote"];
  return order.find(failure => problems.some(problem => problem.failure === failure)) ?? "invalid_output";
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
  let reason: "model_unavailable" | "model_failed" | VerificationFailure = "model_unavailable";
  if (callModel) {
    reason = "model_failed";
    try {
      const answer = await runMaterialModel(prompt, callModel, settings, options.observe, options.onProgress);
      options.onProgress?.("checking_citations");
      let result = interpret(answer.text, prompt, answer.sources);
      // One revision, inside the same request budget, before falling back to course guides or excerpts.
      if (result.kind === "rejected" && answer.revise) {
        options.observe?.({ event: "material_retry", reason: mainFailure(result.problems) });
        reason = mainFailure(result.problems);
        result = interpret(await answer.revise(revisionRequest(result.problems)), prompt, answer.sources);
      }
      if (result.kind === "explained") return result.explanation;
      reason = mainFailure(result.problems);
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
