import { z } from "zod";
import { readServerEvents } from "../contracts/event-stream.js";
import { ModelFailure, type ModelMessage, type ModelReply, type ModelUsage, type ReplyDelta, type StudyModel, type ToolCall } from "../runtime/model.js";

const usageSchema = z.object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() });
const usage = (value: unknown): ModelUsage | undefined => {
  const parsed = usageSchema.safeParse(value);
  return parsed.success ? { inputTokens: parsed.data.prompt_tokens, outputTokens: parsed.data.completion_tokens } : undefined;
};

const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});
const completionSchema = z.object({
  usage: z.unknown().optional(),
  choices: z.array(z.object({
    finish_reason: z.enum(["stop", "tool_calls", "length"]),
    message: z.object({
      content: z.string().nullish(),
      tool_calls: z.array(toolCallSchema).nullish(),
    }),
  })).nonempty(),
});

const textChunkSchema = z.object({
  error: z.never().optional(),
  usage: z.unknown().optional(),
  choices: z.array(z.object({
    finish_reason: z.enum(["stop", "length"]).nullable(),
    delta: z.object({ content: z.string().nullish(), tool_calls: z.never().nullish() }),
  })).max(1),
});

const maxReplyBytes = 8 * 1024 * 1024;

async function readTextCompletion(response: Response, onTextDelta?: ReplyDelta): Promise<ModelReply> {
  let text = "";
  let receivedBytes = 0;
  let finish: "stop" | "length" | null = null;
  let reportedUsage: ModelUsage | undefined;
  for await (const data of readServerEvents(response, maxReplyBytes)) {
    if (data === "[DONE]") {
      const reply = text.trim();
      if (finish === "length") throw new ModelFailure("truncated", undefined, reportedUsage);
      if (finish === "stop" && reply) return { kind: "text", text: reply, ...(reportedUsage && { usage: reportedUsage }) };
      break;
    }
    const chunk = textChunkSchema.parse(JSON.parse(data));
    reportedUsage = usage(chunk.usage) ?? reportedUsage;
    const [choice] = chunk.choices;
    if (!choice) continue;
    if (finish) throw new ModelFailure("invalid_response");
    finish = choice.finish_reason;
    if (finish === "length") continue;
    const delta = choice.delta.content;
    if (delta) {
      receivedBytes += Buffer.byteLength(delta);
      if (receivedBytes > maxReplyBytes) throw new Error("Learning model reply is too large");
      text += delta;
      onTextDelta?.(delta);
    }
  }
  throw new ModelFailure("invalid_response");
}

function wireCall({ id, name, arguments: args }: ToolCall) {
  return { id, type: "function", function: { name, arguments: args } };
}

function wireMessage(message: ModelMessage) {
  if (message.role === "tool") {
    return { role: message.role, content: message.content, tool_call_id: message.toolCallId };
  }
  if ("toolCalls" in message) {
    return { role: message.role, content: message.content, tool_calls: message.toolCalls.map(wireCall) };
  }
  return message;
}

interface ChatCompletionsOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  tokenParameter?: "max_tokens" | "max_completion_tokens";
}

export function createChatCompletionsModel({
  env = process.env, fetchImpl = fetch, tokenParameter = "max_tokens",
}: ChatCompletionsOptions = {}): StudyModel | null {
  const key = env.STUDY_AGENT_API_KEY?.trim();
  if (!key) return null;

  const base = env.STUDY_AGENT_BASE_URL?.trim() || "https://api.deepseek.com";
  const model = env.STUDY_AGENT_MODEL?.trim() || "deepseek-flash";
  const endpoint = new URL("chat/completions", base.replace(/\/+$/, "") + "/");
  return async ({ system, messages, format, tools, toolChoice, signal, maxOutputTokens, onTextDelta }) => {
    const streamText = format === "text" && !tools?.length;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages.map(wireMessage)],
        ...(format === "json" ? { response_format: { type: "json_object" } } : {}),
        ...(tools?.length ? { tools: tools.map(tool => ({ type: "function", function: tool })) } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...(streamText ? { stream: true } : {}),
        ...(streamText && endpoint.hostname === "api.openai.com"
          ? { stream_options: { include_usage: true } } : {}),
        [tokenParameter]: maxOutputTokens,
        ...(endpoint.hostname === "api.deepseek.com" ? { thinking: { type: "disabled" } } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ModelFailure(response.status === 429 ? "rate_limited" : "http_error", response.status);
    }
    try {
      return streamText ? await readTextCompletion(response, onTextDelta) : await readCompletion(response);
    } catch (error) {
      if (signal.aborted || error instanceof ModelFailure) throw error;
      throw new ModelFailure("invalid_response");
    }
  };
}

async function readCompletion(response: Response): Promise<ModelReply> {
  const completion = completionSchema.parse(await response.json());
  const { message, finish_reason: finishReason } = completion.choices[0];
  const reportedUsage = usage(completion.usage);
  if (finishReason === "length") throw new ModelFailure("truncated", undefined, reportedUsage);
  const calls = message.tool_calls ?? [];
  if ((finishReason === "tool_calls") !== (calls.length > 0)) throw new ModelFailure("invalid_response");
  if (finishReason === "tool_calls") {
    return {
      kind: "tool_calls",
      text: message.content ?? null,
      calls: calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      ...(reportedUsage && { usage: reportedUsage }),
    };
  }
  const text = message.content?.trim();
  if (!text) throw new ModelFailure("invalid_response");
  return { kind: "text", text, ...(reportedUsage && { usage: reportedUsage }) };
}
