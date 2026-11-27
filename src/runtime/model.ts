import type { ConversationSource } from "../contracts/conversation.js";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MaterialPrompt {
  question: string;
  history: ConversationMessage[];
  sources: ConversationSource[];
  memory?: string;
  offerReview?: true;
  review?: { question: string; answer: string };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelTool {
  name: string;
  description: string;
  parameters: object;
}

export type ModelMessage =
  | ConversationMessage
  | { role: "assistant"; content: string | null; toolCalls: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelReply = (
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; text: string | null; calls: ToolCall[] }
) & { usage?: ModelUsage };

export class ModelFailure extends Error {
  constructor(
    readonly reason: "rate_limited" | "truncated" | "http_error" | "invalid_response",
    readonly status?: number,
    readonly usage?: ModelUsage,
  ) {
    super(reason);
  }
}

export interface ModelInput {
  system: string;
  messages: ModelMessage[];
  format: "text" | "json";
  tools?: ModelTool[];
  toolChoice?: "none";
}

export type ReplyDelta = (text: string) => void;
export type ModelClient = (request: ModelInput & {
  signal: AbortSignal;
  maxOutputTokens: number;
  onTextDelta?: ReplyDelta;
}) => Promise<ModelReply>;
export type CallModel = (input: ModelInput) => Promise<ModelReply>;
