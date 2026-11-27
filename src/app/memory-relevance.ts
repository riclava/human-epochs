import type { PersonalMemory } from "../contracts/personal-memory.js";

export const recalledMemoryLimit = 4;

// Common two-character words that say nothing about a learning topic. Matching them would tie unrelated memories
// to almost any question.
const stopwords = new Set([
  "我想", "我们", "你们", "我的", "我在", "我要", "我是", "我会", "我能", "一个", "这个", "那个", "什么", "怎么", "怎样",
  "如何", "为什", "可以", "需要", "应该", "已经", "还是", "就是", "因为", "所以", "但是", "如果", "没有", "有没", "是不",
  "不是", "一下", "一些", "时候", "比较", "现在", "之前", "以后", "帮我", "请问", "能不", "多久", "合适", "怎么样",
]);

// Latin words and numbers count whole. Han text counts as overlapping two-character pieces, which is how Chinese
// words most often line up without a dictionary.
export function relevanceTokens(text: string) {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  for (const word of lower.match(/[\p{Script=Latin}\p{N}]+(?:['’.+#-][\p{Script=Latin}\p{N}]+)*/gu) ?? []) {
    if (Array.from(word).length >= 2) tokens.add(word);
  }
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    const characters = Array.from(run);
    for (let index = 0; index + 1 < characters.length; index++) {
      const pair = characters[index]! + characters[index + 1]!;
      if (!stopwords.has(pair)) tokens.add(pair);
    }
  }
  return tokens;
}

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
