import type { AgentSettings } from "../contracts/agent-settings.js";
import type { ConversationProgress, ConversationSource } from "../contracts/conversation.js";
import type { ObserveRun } from "./diagnostics.js";
import type { CallModel, MaterialPrompt, ModelMessage, ModelTool } from "./model.js";
import { limitModelHistory } from "./model-history.js";
import { runModelLoopWithTranscript } from "./model-loop.js";
import { materialPrompt, memoryDataNote } from "./prompts.js";
import { createSourceReader, sourceCatalog } from "./tools/read-source.js";

const toolNote = "输入中的 sources 是所选材料的来源目录，列出每份原文的 ID、名称、字数和段数。原文按段读取：" +
  "先用 search_source 按问题里的关键词查找，它会返回命中位置附近的原文；够用时直接据此作答，需要更完整的上下文再用 read_source 按来源 ID 和段号读取整段。短原文可以直接读第 1 段。" +
  "引文须逐字出自本轮 search_source 或 read_source 返回的原文。如果结果包含 previousToolCallId，沿用该调用已返回的原文。";
const offerNote = "如有据可循且值得复习，可以额外返回 review 对象，包含 topic（简短主题）、question（下次的复习题，只给题面）、answer（作答要点）、afterDays（建议隔 1 至 30 天，整数）、sourceId（来源 ID）和 quote（逐字引用本轮已读的原文，可以是课程原文，也可以是用户附加的原文）。作答要点必须能用该处原文支持。避免重复上次的题面。复习建议只放在 review 字段，没有合适内容时省略。";
const reviewNote = "输入中的 review 包含已发布的复习题及参考要点。如果用户在作答或明确说想不起来，基于原文给反馈，在 blocks 之外返回 reviewAnswered 为 true，并返回 reviewOutcome 对象 {\"result\":\"recalled|partial|forgotten\",\"note\":\"一句判断依据\"}：评判只看用户这一次的回答，逐条对照参考要点；之前的讨论、你的讲解和原文本身都不算用户答出的内容。用户自己说出全部参考要点（包括其中的数字、条件和顺序）为 recalled；只说出一部分、说得含糊（例如没有给出要点里的具体数值）或有偏差为 partial；想不起来、答非所问或答错为 forgotten。note 会展示给用户本人，用第二人称「你」写明答出了哪些要点、缺了哪些，例如「你说出了要先配平，但没有说出 0.1 克这个阈值。」下次复习建议的间隔随结果调整：forgotten 1 至 2 天，partial 2 至 7 天，recalled 4 天以上。引文须逐字出自原文。用户只要求看答案时，给解释并省略 reviewAnswered 和下次复习建议。若用户开始聊别的，回应新的问题，只返回 {\"otherTopic\":\"回复\"}，省略复习题和复习建议。";

const goalNote = "输入中的 currentGoal 是这段对话所属的学习目标，progress 是用户写下的目前进展。只有这次 reviewOutcome 为 recalled，并且这道题考的内容在 progress 里还没有体现时，在 blocks 之外返回 goalProgress 字符串：用第一人称写现在会了什么，保留原进展里仍然成立的内容，不超过 80 个字。其他情况省略 goalProgress，也不要在正文里提到它。";

export interface MaterialAnswer {
  text: string;
  sources: ConversationSource[];
  // Present while the request has a model call left. Asks the model to fix its reply, given what failed verification.
  revise?: (feedback: string) => Promise<string>;
}

export async function runMaterialModel(
  prompt: MaterialPrompt, callModel: CallModel, settings: Readonly<AgentSettings>,
  observe?: ObserveRun, onProgress?: (progress: ConversationProgress) => void,
): Promise<MaterialAnswer> {
  const input = { ...prompt, history: limitModelHistory(prompt.history, settings.historyBytes) };
  const system = [materialPrompt, input.memory && memoryDataNote, input.offerReview && offerNote, input.review && reviewNote,
    input.review && input.currentGoal && goalNote]
    .filter(Boolean).join("\n");
  const reviser = (messages: ModelMessage[], text: string, used: number, tools: ModelTool[]) =>
    used < settings.maxModelCalls ? async (feedback: string) => {
      const answer = await callModel({
        system: tools.length ? system + "\n" + toolNote : system, format: "json",
        messages: [...messages, { role: "assistant", content: text }, { role: "user", content: feedback }],
        ...(tools.length ? { tools, toolChoice: "none" as const } : {}),
      });
      if (answer.kind !== "text") throw new Error("A revision must be a text reply");
      return answer.text;
    } : undefined;

  if (prompt.sources.reduce((length, source) => length + source.text.length, 0) <= settings.inlineSourceChars) {
    const run = await runModelLoopWithTranscript(callModel, {
      system,
      messages: [{ role: "user", content: JSON.stringify(input) }],
      format: "json",
    });
    return { text: run.text, sources: prompt.sources, revise: reviser(run.messages, run.text, run.modelCalls, []) };
  }

  const catalog = sourceCatalog(prompt.sources);
  const { tools, readSources } = createSourceReader(prompt.sources);
  onProgress?.("reading_sources");
  const run = await runModelLoopWithTranscript(callModel, {
    system: system + "\n" + toolNote,
    messages: [{ role: "user", content: JSON.stringify({ ...input, sources: catalog }) }],
    format: "json",
  }, { tools, maxModelCalls: settings.maxModelCalls, maxToolCalls: settings.maxToolCalls, observe });

  // A revision cannot read more, so its citations are checked against what the first pass read.
  return { text: run.text, sources: readSources(), revise: reviser(run.messages, run.text, run.modelCalls, tools.map(tool => tool.definition)) };
}
