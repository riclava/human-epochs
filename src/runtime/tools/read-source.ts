import { z } from "zod";
import type { ChatSource } from "../../contracts/chat.js";
import type { ReadOnlyTool } from "../model-loop.js";

const inputSchema = z.strictObject({ sourceId: z.string().min(1) });
const outputSchema = z.strictObject({ id: z.string(), label: z.string(), text: z.string() });
const referenceSchema = z.strictObject({ id: z.string(), previousToolCallId: z.string() });
const definition = {
  name: "read_source",
  description: "按目录中的来源 ID 读取本轮已选原文。",
  parameters: z.toJSONSchema(inputSchema),
};

export function createSourceReader(sources: ChatSource[]) {
  const read = new Map<string, { source: ChatSource; callId: string }>();
  const tool: ReadOnlyTool = {
    definition,
    execute(input, callId) {
      const args = inputSchema.safeParse(input);
      if (!args.success) return { outcome: "invalid_input", output: { error: "请提供材料目录中的来源 ID。" } };

      const source = sources.find(item => item.id === args.data.sourceId);
      if (!source) return { outcome: "denied", output: { error: "请使用本轮材料目录中的来源 ID。" } };

      const { id, label, text } = source;
      const previous = read.get(id);
      if (previous) return { outcome: "returned", output: referenceSchema.parse({ id, previousToolCallId: previous.callId }) };

      const output = outputSchema.parse({ id, label, text });
      read.set(id, { source: output, callId });
      return { outcome: "returned", output };
    },
  };
  return { tool, readSources: () => [...read.values()].map(entry => entry.source) };
}
