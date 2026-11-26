import type { ObserveRun, ToolOutcome } from "./diagnostics.js";
import type { CallModel, ModelInput, ModelTool, ToolCall } from "./model.js";

export interface ReadOnlyTool {
  definition: ModelTool;
  execute(input: unknown, callId: string): { outcome: "returned" | "invalid_input" | "denied"; output: object };
}

type ToolOptions = {
  tools: ReadOnlyTool[];
  maxModelCalls: number;
  maxToolCalls: number;
  observe?: ObserveRun;
};

function executeTool(call: ToolCall, tool: ReadOnlyTool | undefined): { outcome: ToolOutcome; output: object } {
  if (!tool) return { outcome: "unknown_tool", output: { error: "请选择本轮提供的工具。" } };

  let input: unknown;
  try {
    input = JSON.parse(call.arguments);
  } catch {
    return { outcome: "invalid_input", output: { error: "工具参数必须是有效的 JSON。" } };
  }
  return tool.execute(input, call.id);
}

export async function runModelLoop(
  callModel: CallModel, input: Pick<ModelInput, "system" | "messages" | "format">, options?: ToolOptions,
): Promise<string> {
  const tools = options?.tools ?? [];
  const maxModelCalls = options?.maxModelCalls ?? 1;
  const maxToolCalls = options?.maxToolCalls ?? 0;
  const definitions = tools.map(tool => tool.definition);
  const callIds = new Set<string>();
  let messages = input.messages;

  for (let step = 1; step <= maxModelCalls; step++) {
    const remaining = maxToolCalls - callIds.size;
    const mayCallTool = step < maxModelCalls && remaining > 0;
    const answer = await callModel({
      ...input, messages,
      ...(definitions.length ? { tools: definitions, toolChoice: mayCallTool ? undefined : "none" } : {}),
    });
    if (answer.kind === "text") return answer.text;
    if (!mayCallTool || answer.calls.length === 0 || answer.calls.length > remaining) {
      throw new Error("Tool calls exceed the model or tool budget");
    }

    for (const call of answer.calls) {
      if (!call.id || callIds.has(call.id)) throw new Error("Invalid tool call ID");
      callIds.add(call.id);
    }
    const results = answer.calls.map(call => {
      const tool = tools.find(tool => tool.definition.name === call.name);
      const start = performance.now();
      let outcome: ToolOutcome = "failed";
      try {
        const result = executeTool(call, tool);
        outcome = result.outcome;
        return { role: "tool" as const, toolCallId: call.id, content: JSON.stringify(result.output) };
      } finally {
        options?.observe?.({ event: "tool", tool: tool?.definition.name,
          toolCallId: /^[a-z0-9_-]{1,128}$/i.test(call.id) ? call.id : undefined,
          elapsedMs: Math.round(performance.now() - start), outcome });
      }
    });
    messages = [...messages, { role: "assistant", content: answer.text, toolCalls: answer.calls }, ...results];
  }

  throw new Error("Model call budget exhausted");
}
