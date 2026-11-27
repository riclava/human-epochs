import type { PersonalMemory } from "../contracts/personal-memory.js";
import { relevanceTokens } from "../runtime/text-relevance.js";

export { relevanceTokens };

export const recalledMemoryLimit = 4;

type Scored = Pick<PersonalMemory, "topic" | "body">;

// A whole topic in the question counts most, then shared topic pieces, then shared body pieces.
export function memoryRelevance(question: string, memory: Scored) {
  const asked = relevanceTokens(question);
  let score = memory.topic && question.toLowerCase().includes(memory.topic.toLowerCase()) ? 3 : 0;
  for (const token of relevanceTokens(memory.topic)) if (asked.has(token)) score += 2;
  for (const token of relevanceTokens(memory.body)) if (asked.has(token)) score += 1;
  return score;
}

// A memory with a topic applies only to questions related to it. A memory without one applies to any question.
export function memoryApplies(question: string, memory: Scored) {
  return !memory.topic || memoryRelevance(question, memory) > 0;
}

// Related memories come first, most related first. General memories without a topic fill the remaining places.
// The sort is stable, so equal scores keep the caller's order (most recently updated first).
export function selectMemories<T extends Scored>(question: string, memories: readonly T[], limit = recalledMemoryLimit): T[] {
  const scored = memories.map(memory => ({ memory, score: memoryRelevance(question, memory) }));
  const related = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  const general = scored.filter(item => item.score === 0 && !item.memory.topic);
  return [...related, ...general].slice(0, limit).map(item => item.memory);
}
