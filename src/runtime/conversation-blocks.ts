import { conversationContentDraftSchema, type ConversationContentDraft } from "../contracts/conversation.js";

export const structuredFenceKinds = ["event_log", "diagram", "goal", "goal_progress"] as const;
export const structuredBlockLimit = 3;

// A fence opens at the start of a line with ``` and a structured kind, and closes at the next line that is only ```.
const fence = /^```(event_log|diagram|goal|goal_progress)[ \t]*\n([\s\S]*?)\n```[ \t]*$/gmu;
// The fence name the model writes, and the block kind it becomes.
const blockKind = (fenceKind: string) => ({ goal: "goal_proposal", goal_progress: "goal_progress_proposal" })[fenceKind] ?? fenceKind;

function parseStructured(fenceKind: string, body: string): ConversationContentDraft | null {
  const kind = blockKind(fenceKind);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Ordinary conversation has no readable source, so any citations the model invents are dropped, and the goal a
  // progress proposal is for comes from the conversation, not the model.
  const { citations: _citations, kind: _kind, goalId: _goalId, ...fields } = value as Record<string, unknown>;
  const parsed = conversationContentDraftSchema.safeParse({ ...fields, kind });
  return parsed.success && parsed.data.kind === kind ? parsed.data : null;
}

// A title's tokens: whole Latin words and numbers, and character pairs of the other text, ignoring punctuation.
const tokens = (title: string) => new Set([...title.toLowerCase().matchAll(/[a-z0-9]+|[^\sa-z0-9\p{P}\p{S}]+/gu)].flatMap(([run]) => {
  if (/^[a-z0-9]/u.test(run)) return [run];
  const characters = Array.from(run);
  return characters.length < 2 ? characters : characters.slice(1).map((character, index) => characters[index] + character);
}));

// Two titles name the same goal when at least half of the shorter one's tokens appear in the other. "系统学会看天气图"
// and "看懂天气图" share 天气 and 气图, half of the shorter; "用 Python 做数据分析" and "学 Python 写爬虫" share only python.
function sameGoal(a: string, b: string) {
  const [left, right] = [tokens(a), tokens(b)];
  if (!left.size || !right.size) return false;
  const shared = [...left].filter(token => right.has(token)).length;
  return shared / Math.min(left.size, right.size) >= 0.5;
}

// Drops a goal proposal that repeats a goal the user already has, in any status, and gives a progress proposal the
// conversation's active goal, dropping it when there is none.
export function settleGoalProposals(blocks: ConversationContentDraft[], knownTitles: readonly string[], currentGoalId?: string) {
  return blocks.flatMap((block): ConversationContentDraft[] => {
    if (block.kind === "goal_proposal") return knownTitles.some(title => sameGoal(title, block.title)) ? [] : [block];
    if (block.kind === "goal_progress_proposal") return currentGoalId ? [{ ...block, goalId: currentGoalId }] : [];
    return [block];
  });
}

// Splits a Markdown reply at structured fences. Valid fences become event log, diagram or goal proposal blocks in
// place; an invalid view stays in the text as an ordinary code block, so a malformed view never fails the reply, and
// an invalid proposal is dropped. A reply keeps at most one proposal of each kind.
export function splitConversationReply(reply: string): ConversationContentDraft[] {
  const blocks: ConversationContentDraft[] = [];
  let text = "";
  let cursor = 0;
  let structured = 0;
  const proposed = new Set<string>();
  const flush = () => {
    const trimmed = text.trim();
    if (trimmed) blocks.push({ kind: "text", text: trimmed });
    text = "";
  };
  for (const match of reply.matchAll(fence)) {
    text += reply.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const isGoal = match[1]!.startsWith("goal");
    if (isGoal && proposed.has(match[1]!)) continue;
    const block = isGoal || structured < structuredBlockLimit ? parseStructured(match[1]!, match[2]!) : null;
    if (!block) {
      // A malformed view stays readable as code; a malformed proposal is only raw JSON, so it is left out.
      if (!isGoal) text += match[0];
      continue;
    }
    if (isGoal) proposed.add(match[1]!);
    else structured++;
    flush();
    blocks.push(block);
  }
  text += reply.slice(cursor);
  flush();
  return blocks;
}
