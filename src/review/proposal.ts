import { z } from "zod";
import type { ConversationSource } from "../contracts/conversation.js";

const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\u0000\uD800-\uDFFF]/u.test(value));
const proposalSchema = z.strictObject({
  topic: text(80), question: text(600), answer: text(800), afterDays: z.int().min(1).max(30),
  sourceId: text(160), quote: text(1200),
});

export type ReviewProposal = Omit<z.infer<typeof proposalSchema>, "sourceId"> & { source: ConversationSource };

export function reviewProposal(value: unknown, sources: ConversationSource[]): ReviewProposal | undefined {
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) return;
  const { sourceId, ...draft } = parsed.data;
  const source = sources.find(candidate => candidate.id === sourceId && candidate.text.includes(draft.quote));
  if (source) return { ...draft, source };
}
