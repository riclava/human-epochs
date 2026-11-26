import type { Pool } from "pg";
import type { ChatMaterialInput, ChatProgress, ChatSnapshot, ChatTurn } from "../../contracts/chat.js";
import type { ObserveRun } from "../../runtime/diagnostics.js";
import type { ReplyDelta } from "../../runtime/model.js";
import { createTurnRunner, type TurnReply } from "../../runtime/run-turn.js";
import type { createAgentSettingsService } from "../agent-settings.js";
import { loadContext } from "./context.js";
import { listMaterials } from "./materials.js";
import { isActiveAttempt, publishTurn, readTurns, receiveTurn, stopActiveTurn, type TurnMemory } from "./turns.js";

type PreparedTurn =
  | { kind: "conflict"; message: string }
  | { kind: "invalid_material" }
  | { kind: "existing"; turn: ChatTurn }
  | { kind: "claimed"; run: (onTextDelta: ReplyDelta, onProgress: (progress: ChatProgress) => void) => Promise<ChatTurn> };

type ChatLog = (event: Parameters<ObserveRun>[0] & { attempt: number } | {
  event: "receipt" | "publish" | "stop";
  attempt?: number;
  elapsedMs: number;
  outcome: string;
  status?: ChatTurn["status"];
  explanationMode?: ChatTurn["explanationMode"];
  reason?: string;
}) => void;

export function createChatService(pool: Pool, settings: Pick<ReturnType<typeof createAgentSettingsService>, "view" | "execution">) {
  const active = new Map<string, AbortController>();
  const attemptKey = (learnerId: string, requestId: string, attempt: number) => `${learnerId}:${requestId}:${attempt}`;

  async function prepareTurn(
    learnerId: string, { requestId, text, material }: { requestId: string; text: string; material?: ChatMaterialInput },
    log: ChatLog,
  ): Promise<PreparedTurn> {
    const start = performance.now();
    const receipt = await receiveTurn(pool, learnerId, requestId, text, material);
    log({ event: "receipt", elapsedMs: Math.round(performance.now() - start), outcome: receipt.kind,
      attempt: "attempt" in receipt ? receipt.attempt : undefined });
    if (receipt.kind !== "claimed") return receipt;
    const { attempt, deadline, material: savedMaterial } = receipt;
    const key = attemptKey(learnerId, requestId, attempt);
    const controller = new AbortController();
    active.set(key, controller);

    async function run(onTextDelta: ReplyDelta, onProgress: (progress: ChatProgress) => void) {
      let output: TurnReply | null = null;
      let memory: TurnMemory | undefined;
      let reason: string | undefined = "context_failed";
      try {
        const config = await settings.execution();
        const loaded = await loadContext(pool, learnerId, requestId, text, savedMaterial, config.settings, !!config.model);
        memory = loaded.memory;
        if (!controller.signal.aborted && await isActiveAttempt(pool, learnerId, requestId, attempt)) {
          const result = await createTurnRunner(config.model).runTurn(loaded.context, deadline, config.settings, {
            signal: controller.signal,
            onTextDelta: memory?.guarded ? undefined : onTextDelta,
            onProgress,
            observe: event => log({ ...event, attempt }),
          });
          reason = result.kind === "failed" ? result.reason : undefined;
          if (result.kind === "complete") output = result.output;
        } else reason = "inactive_attempt";
      } catch {
        // A context read can fail after receipt. Publish the attempt's retry state.
      }
      const publishStart = performance.now();
      try {
        const { turn, outcome } = await publishTurn(pool, learnerId, requestId, attempt, output, memory);
        log({ event: "publish", attempt, elapsedMs: Math.round(performance.now() - publishStart), outcome,
          status: turn.status, explanationMode: turn.explanationMode, reason });
        return turn;
      } catch (error) {
        log({ event: "publish", attempt, elapsedMs: Math.round(performance.now() - publishStart), outcome: "write_failed" });
        throw error;
      } finally {
        active.delete(key);
      }
    }
    return { kind: "claimed", run };
  }

  async function stopTurn(learnerId: string, requestId: string, log: ChatLog) {
    const start = performance.now();
    const { turn, stoppedAttempt } = await stopActiveTurn(pool, learnerId, requestId);
    if (stoppedAttempt !== undefined) active.get(attemptKey(learnerId, requestId, stoppedAttempt))?.abort();
    log({ event: "stop", attempt: stoppedAttempt, elapsedMs: Math.round(performance.now() - start),
      outcome: stoppedAttempt !== undefined ? "stopped" : turn ? "existing" : "missing", status: turn?.status });
    return turn;
  }

  async function readSnapshot(learnerId: string): Promise<ChatSnapshot> {
    const [turns, { assistantAvailable }] = await Promise.all([readTurns(pool, learnerId), settings.view()]);
    return { turns, mode: assistantAvailable ? "model" : "guided" };
  }

  return { prepareTurn, stopTurn, readSnapshot, listMaterials };
}
