import { z } from "zod";
import type { ConversationSource } from "../contracts/conversation.js";

const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value));
const proposalSchema = z.strictObject({
  topic: text(80), question: text(600), answer: text(800), afterDays: z.int().min(1).max(30),
  sourceId: text(160), quote: text(1200),
});

export type ReviewProposal = Omit<z.infer<typeof proposalSchema>, "sourceId"> & { source: ConversationSource };

export const evidencePassageLimit = 3000;

// A long source keeps only the passage around the quote as review evidence, so it reads as whole sentences.
export function evidencePassage(text: string, quote: string) {
  if (text.length <= evidencePassageLimit) return text;
  const at = text.indexOf(quote);
  const margin = Math.max(0, Math.floor((evidencePassageLimit - quote.length) / 2));
  let start = Math.max(0, at - margin);
  let end = Math.min(text.length, at + quote.length + margin);
  const isBreak = (character: string | undefined) => !!character && "。！？\n".includes(character);
  for (let index = start; index < at; index++) if (isBreak(text[index])) { start = index + 1; break; }
  for (let index = end - 1; index >= at + quote.length; index--) if (isBreak(text[index])) { end = index + 1; break; }
  return text.slice(start, end).trim();
}

export function reviewProposal(value: unknown, sources: ConversationSource[]): ReviewProposal | undefined {
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) return;
  const { sourceId, ...draft } = parsed.data;
  const source = sources.find(candidate => candidate.id === sourceId && candidate.text.includes(draft.quote));
  if (source) return { ...draft, source: { ...source, text: evidencePassage(source.text, draft.quote) } };
}

export const reviewOutcomes = ["recalled", "partial", "forgotten"] as const;
export type ReviewOutcomeResult = typeof reviewOutcomes[number];
const outcomeSchema = z.strictObject({ result: z.enum(reviewOutcomes), note: text(200) });
export type ReviewOutcome = z.infer<typeof outcomeSchema>;

// How well an answer recalled the reviewed point, as judged by the model giving feedback.
export function reviewOutcome(value: unknown): ReviewOutcome | undefined {
  const parsed = outcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// The next interval follows the result: a forgotten point comes back soon, a recalled one waits longer.
// The model proposes the days; these bounds keep the proposal pointing the same way as the result.
const intervalBounds: Record<ReviewOutcomeResult, [number, number]> = { forgotten: [1, 2], partial: [2, 7], recalled: [4, 30] };

export function intervalForOutcome(afterDays: number, result: ReviewOutcomeResult) {
  const [low, high] = intervalBounds[result];
  return Math.min(high, Math.max(low, afterDays));
}
