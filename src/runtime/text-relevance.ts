// Literal relevance shared by memory recall and source search. It needs no dictionary or embedding service.

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
