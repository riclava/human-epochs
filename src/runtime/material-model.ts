import type { AgentSettings } from "../contracts/agent-settings.js";
import type { ChatProgress } from "../contracts/chat.js";
import type { ObserveRun } from "./diagnostics.js";
import type { CallModel, MaterialPrompt } from "./model.js";
import { limitModelHistory } from "./model-history.js";
import { runModelLoop } from "./model-loop.js";
import { materialPrompt, memoryDataNote } from "./prompts.js";
import { createSourceReader } from "./tools/read-source.js";

const toolPrompt = materialPrompt + "\n" +
  "输入中的 sources 是已选材料目录。使用 read_source 读取回答所需的原文，引用只可来自本轮工具返回的原文。" +
  "如果结果包含 previousToolCallId，沿用该调用已返回的原文。";

export async function runMaterialModel(
  prompt: MaterialPrompt, callModel: CallModel, settings: Readonly<AgentSettings>,
  observe?: ObserveRun, onProgress?: (progress: ChatProgress) => void,
) {
  const input = { ...prompt, history: limitModelHistory(prompt.history, settings.historyBytes) };
  if (prompt.sources.reduce((length, source) => length + source.text.length, 0) <= settings.inlineSourceChars) {
    const text = await runModelLoop(callModel, {
      system: input.memory ? materialPrompt + "\n" + memoryDataNote : materialPrompt,
      messages: [{ role: "user", content: JSON.stringify(input) }],
      format: "json",
    });
    return { text, sources: prompt.sources };
  }

  const catalog = prompt.sources.map(({ id, label }) => ({ id, label }));
  const { tool, readSources } = createSourceReader(prompt.sources);
  onProgress?.("reading_sources");
  const text = await runModelLoop(callModel, {
    system: input.memory ? toolPrompt + "\n" + memoryDataNote : toolPrompt,
    messages: [{ role: "user", content: JSON.stringify({ ...input, sources: catalog }) }],
    format: "json",
  }, { tools: [tool], maxModelCalls: settings.maxModelCalls, maxToolCalls: settings.maxToolCalls, observe });

  return { text, sources: readSources() };
}
