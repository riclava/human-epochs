import type { Pool } from "pg";
import type { ConversationCommand, ConversationProgress, ConversationSnapshot, ConversationTurn, ReviewInvitationCommand, SendConversationCommand, UserConversationTurn } from "../../contracts/conversation.js";
import { publishedDiscussions } from "../../courses/catalog.js";
import { readDueReviewInvitation } from "../../review/invitations.js";
import type { ObserveRun } from "../../runtime/diagnostics.js";
import type { ReplyDelta } from "../../runtime/model.js";
import { createTurnRunner, type TurnReply } from "../../runtime/run-turn.js";
import { inTransaction } from "../../storage/transaction.js";
import type { createAgentSettingsService } from "../agent-settings.js";
import { readPersonalMemories } from "../personal-memories.js";
import { loadContext } from "./context.js";
import { isDeletedConversation, listConversations, readConversationHeading, runConversationCommand } from "./conversations.js";
import { listMaterials } from "./materials.js";
import { runReviewInvitationCommand } from "./review-invitations.js";
import { isActiveAttempt, publishTurn, readTurns, receiveTurn, stopActiveTurn, type TurnMemory } from "./turns.js";

type PreparedTurn =
  | { kind: "conflict"; message: string }
  | { kind: "invalid_material" }
  | { kind: "invalid_review" }
  | { kind: "deleted" }
  | { kind: "existing"; turn: ConversationTurn }
  | { kind: "claimed"; run: (onTextDelta: ReplyDelta, onProgress: (progress: ConversationProgress) => void) => Promise<ConversationTurn> };

type ConversationLog = (event: Parameters<ObserveRun>[0] & { attempt: number } | {
  event: "receipt" | "publish" | "stop";
  attempt?: number;
  elapsedMs: number;
  outcome: string;
  status?: ConversationTurn["status"];
  explanationSource?: UserConversationTurn["explanationSource"];
  reason?: string;
}) => void;

export function createConversationService(
  pool: Pool, settings: Pick<ReturnType<typeof createAgentSettingsService>, "view" | "execution">,
  now = () => new Date(),
) {
  const active = new Map<string, AbortController>();
  const attemptKey = (userId: string, requestId: string, attempt: number) => `${userId}:${requestId}:${attempt}`;

  async function prepareTurn(
    userId: string,
    command: SendConversationCommand,
    log: ConversationLog,
  ): Promise<PreparedTurn> {
    const start = performance.now();
    const { requestId, messageText } = command;
    const receipt = await receiveTurn(pool, userId, command);
    log({ event: "receipt", elapsedMs: Math.round(performance.now() - start), outcome: receipt.kind,
      attempt: "attempt" in receipt ? receipt.attempt : undefined });
    if (receipt.kind !== "claimed") return receipt;
    const { attempt, deadline, materialContext, reviewInvitationId: savedReviewInvitationId } = receipt;
    const key = attemptKey(userId, requestId, attempt);
    const controller = new AbortController();
    active.set(key, controller);

    async function run(onTextDelta: ReplyDelta, onProgress: (progress: ConversationProgress) => void) {
      let output: TurnReply | null = null;
      let memory: TurnMemory | undefined;
      let reason: string | undefined = "context_failed";
      let extractMemories = false;
      try {
        const config = await settings.execution();
        extractMemories = !!config.model;
        const loaded = await loadContext(pool, userId, requestId, messageText, materialContext, config.settings, !!config.model, savedReviewInvitationId);
        memory = loaded.memory;
        if (!controller.signal.aborted && await isActiveAttempt(pool, userId, requestId, attempt)) {
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
        const { turn, outcome } = await publishTurn(pool, userId, requestId, attempt, output, {
          memory, reviewInvitationId: savedReviewInvitationId, now: now(), extractMemories,
        });
        log({ event: "publish", attempt, elapsedMs: Math.round(performance.now() - publishStart), outcome,
          status: turn.status, explanationSource: turn.kind === "user" ? turn.explanationSource : undefined, reason });
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

  async function stopTurn(userId: string, requestId: string, log: ConversationLog) {
    const start = performance.now();
    const { turn, stoppedAttempt } = await stopActiveTurn(pool, userId, requestId);
    if (stoppedAttempt !== undefined) active.get(attemptKey(userId, requestId, stoppedAttempt))?.abort();
    log({ event: "stop", attempt: stoppedAttempt, elapsedMs: Math.round(performance.now() - start),
      outcome: stoppedAttempt !== undefined ? "stopped" : turn ? "existing" : "missing", status: turn?.status });
    return turn;
  }

  // A conversation that does not exist yet reads as a new, empty conversation.
  // A deleted conversation has no snapshot.
  async function readSnapshot(userId: string, conversationId: string): Promise<ConversationSnapshot | null> {
    if (await isDeletedConversation(pool, userId, conversationId)) return null;
    const [{ turns, title, goalId, reviewInvitation, personal }, { onlineModelAvailable }] = await Promise.all([inTransaction(pool, async db => {
      await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      const turns = await readTurns(db, userId, conversationId);
      const { title, goalId } = await readConversationHeading(db, userId, conversationId);
      const reviewInvitation = await readDueReviewInvitation(db, userId, now());
      const personal = await readPersonalMemories(db, userId);
      return { turns, title, goalId, reviewInvitation, personal };
    }), settings.view()]);
    const starter = !turns.length && onlineModelAvailable ? publishedDiscussions[0] : undefined;
    return { conversationId, title, goalId, turns, ...personal, mode: onlineModelAvailable ? "model" : "guided", ...(reviewInvitation ? { reviewInvitation } : {}),
      ...(starter ? { starter: { discussionVersion: starter.discussionVersion, title: starter.title, question: starter.question } } : {}) };
  }

  return { prepareTurn, stopTurn, readSnapshot, listMaterials, listConversations: (userId: string) => listConversations(pool, userId),
    runConversationCommand: (userId: string, conversationId: string, command: ConversationCommand) =>
      runConversationCommand(pool, userId, conversationId, command),
    applyReviewInvitationCommand: (userId: string, command: ReviewInvitationCommand) => runReviewInvitationCommand(pool, userId, command, now()),
  };
}
