import type { ConversationContentDraft, ConversationMode, ConversationProgress, UserConversationTurn } from "../contracts/conversation.js";
import type { ReviewProposal } from "../review/proposal.js";
import { defaultAgentSettings, type AgentSettings } from "../contracts/agent-settings.js";
import type { ObserveRun } from "./diagnostics.js";
import { splitConversationReply } from "./conversation-blocks.js";
import { guideConversation } from "./local-guidance.js";
import { discussMaterial, type MaterialPublication } from "./material-discussion.js";
import { ModelFailure, type CallModel, type MaterialPrompt, type ReplyDelta, type ConversationMessage, type ModelClient } from "./model.js";
import { limitModelHistory } from "./model-history.js";
import { runModelLoop } from "./model-loop.js";
import { conversationPrompt, memoryDataNote } from "./prompts.js";

export type TurnContext =
  | { kind: "conversation"; history: ConversationMessage[]; memory?: string }
  | { kind: "material"; prompt: MaterialPrompt; publication?: MaterialPublication };

export interface TurnReply {
  replyBlocks: ConversationContentDraft[];
  explanationSource?: UserConversationTurn["explanationSource"];
  review?: ReviewProposal;
}

type TurnResult =
  | { kind: "complete"; output: TurnReply }
  | { kind: "failed"; reason: "deadline" | "generation" | "empty_reply" | "stopped" };

interface RunOptions {
  onTextDelta?: ReplyDelta;
  onProgress?: (progress: ConversationProgress) => void;
  observe?: ObserveRun;
  signal?: AbortSignal;
}

function modelCaller(
  model: ModelClient, expiresAt: number, settings: Readonly<AgentSettings>, now: () => number, options: RunOptions,
): CallModel {
  let calls = 0;
  return async input => {
    const remaining = expiresAt - now();
    options.signal?.throwIfAborted();
    if (remaining <= 0) throw new Error("Turn deadline reached");
    const timeout = AbortSignal.timeout(Math.min(remaining, settings.modelTimeoutSeconds * 1_000));
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const call = ++calls;
    const start = performance.now();
    try {
      const result = await model({ ...input, signal, maxOutputTokens: settings.maxOutputTokens,
        onTextDelta: options.onTextDelta && (text => {
          if (signal.aborted || now() >= expiresAt) return;
          const delta = text.replaceAll("\u0000", "");
          if (delta) options.onTextDelta?.(delta);
        }),
      });
      signal.throwIfAborted();
      if (now() >= expiresAt) throw new Error("Turn deadline reached");
      options.observe?.({ event: "model", call, elapsedMs: Math.round(performance.now() - start), outcome: result.kind, usage: result.usage });
      return result;
    } catch (error) {
      const failure = error instanceof ModelFailure ? error : undefined;
      const outcome = options.signal?.aborted ? "stopped" : now() >= expiresAt ? "deadline"
        : timeout.aborted ? "timeout" : failure?.reason ?? "request_failed";
      options.observe?.({ event: "model", call, elapsedMs: Math.round(performance.now() - start), outcome,
        httpStatus: failure?.status, usage: failure?.usage });
      throw error;
    }
  };
}

export function createTurnRunner(model: ModelClient | null, now = Date.now) {
  const mode: ConversationMode = model ? "model" : "guided";

  async function runTurn(
    context: TurnContext, deadline: Date, settings: Readonly<AgentSettings> = defaultAgentSettings, options: RunOptions = {},
  ): Promise<TurnResult> {
    const expiresAt = deadline.getTime();
    if (now() >= expiresAt) return { kind: "failed", reason: "deadline" };

    const callModel = model && modelCaller(model, expiresAt, settings, now, {
      ...options, onTextDelta: context.kind === "conversation" ? options.onTextDelta : undefined,
    });
    let output: TurnReply;
    try {
      options.signal?.throwIfAborted();
      switch (context.kind) {
        case "conversation": {
          const latest = context.history.at(-1);
          if (latest?.role !== "user" || !latest.content.trim()) return { kind: "failed", reason: "empty_reply" };
          const reply = callModel
            ? await runModelLoop(callModel, {
              system: context.memory ? conversationPrompt + "\n" + memoryDataNote : conversationPrompt,
              messages: context.memory
                ? [{ role: "user", content: context.memory }, ...context.history]
                : limitModelHistory(context.history, settings.historyBytes), format: "text",
            })
            : guideConversation(context.history);
          output = textReply(reply.replace(/[\u0000\uD800-\uDFFF]/gu, "").trim());
          break;
        }
        case "material": {
          const { replyBlocks, explanationSource, review } = await discussMaterial(context.publication, context.prompt, callModel, settings, options);
          output = { replyBlocks, explanationSource, ...(review ? { review } : {}) };
          break;
        }
      }
      options.signal?.throwIfAborted();
    } catch {
      if (options.signal?.aborted) return { kind: "failed", reason: "stopped" };
      return { kind: "failed", reason: now() >= expiresAt ? "deadline" : "generation" };
    }

    if (now() >= expiresAt) return { kind: "failed", reason: "deadline" };
    return output.replyBlocks.length ? { kind: "complete", output } : { kind: "failed", reason: "empty_reply" };
  }

  return { mode, runTurn };
}

function textReply(text: string): TurnReply {
  return { replyBlocks: text ? splitConversationReply(text) : [] };
}
