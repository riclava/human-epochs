import type { AgentSettings } from "../contracts/agent-settings.js";
import type { ConversationProgress } from "../contracts/conversation.js";
import type { ObserveRun } from "./diagnostics.js";
import type { CallModel, MaterialPrompt } from "./model.js";
import { limitModelHistory } from "./model-history.js";
import { runModelLoop } from "./model-loop.js";
import { materialPrompt, memoryDataNote } from "./prompts.js";
import { createSourceReader } from "./tools/read-source.js";

const toolNote = "输入中的 sources 是所选材料的来源目录。使用 read_source 读取所需原文，引文须逐字出自本轮工具返回的原文。" +
  "如果结果包含 previousToolCallId，沿用该调用已返回的原文。";
const offerNote = "如有据可循且值得复习，可以额外返回 review 对象，包含 topic（简短主题）、question（下次的复习题，只给题面）、answer（作答要点）、afterDays（建议隔 1 至 30 天，整数）、sourceId（来源 ID）和 quote（逐字引用本轮已读的原文，可以是课程原文，也可以是用户附加的原文）。作答要点必须能用该处原文支持。避免重复上次的题面。复习建议只放在 review 字段，没有合适内容时省略。";
const reviewNote = "输入中的 review 包含已发布的复习题及参考要点。如果用户在作答或明确说想不起来，基于原文给反馈，在 blocks 之外返回 reviewAnswered 为 true。引文须逐字出自原文。用户只要求看答案时，给解释并省略 reviewAnswered 和下次复习建议。若用户开始聊别的，回应新的问题，只返回 {\"otherTopic\":\"回复\"}，省略复习题和复习建议。";

export async function runMaterialModel(
  prompt: MaterialPrompt, callModel: CallModel, settings: Readonly<AgentSettings>,
  observe?: ObserveRun, onProgress?: (progress: ConversationProgress) => void,
) {
  const input = { ...prompt, history: limitModelHistory(prompt.history, settings.historyBytes) };
  const system = [materialPrompt, input.memory && memoryDataNote, input.offerReview && offerNote, input.review && reviewNote]
    .filter(Boolean).join("\n");
  if (prompt.sources.reduce((length, source) => length + source.text.length, 0) <= settings.inlineSourceChars) {
    const text = await runModelLoop(callModel, {
      system,
      messages: [{ role: "user", content: JSON.stringify(input) }],
      format: "json",
    });
    return { text, sources: prompt.sources };
  }

  const catalog = prompt.sources.map(({ id, label }) => ({ id, label }));
  const { tool, readSources } = createSourceReader(prompt.sources);
  onProgress?.("reading_sources");
  const text = await runModelLoop(callModel, {
    system: system + "\n" + toolNote,
    messages: [{ role: "user", content: JSON.stringify({ ...input, sources: catalog }) }],
    format: "json",
  }, { tools: [tool], maxModelCalls: settings.maxModelCalls, maxToolCalls: settings.maxToolCalls, observe });

  return { text, sources: readSources() };
}
