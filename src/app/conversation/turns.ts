import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  conversationContentSchema, type ConversationContent, type ConversationMaterialContext, type ConversationMaterialSelection,
  type ConversationTurn, type ReviewQuestionTurn, type SendConversationCommand, type UserConversationTurn,
} from "../../contracts/conversation.js";
import { readReviewInvitations, scheduleReviewInvitation } from "../../review/invitations.js";
import type { TurnReply } from "../../runtime/run-turn.js";
import { inTransaction } from "../../storage/transaction.js";
import { enqueueExtraction } from "../memory-candidates.js";
import { touchConversation } from "./conversations.js";
import { enqueueSummary } from "./summaries.js";
import { discussionChain } from "./history.js";
import { resolveMaterialContext, namedMaterial } from "./materials.js";

const maxAttempts = 3;
const columns = `request_id AS "requestId", message_text AS "messageText",
  reply_blocks AS "replyBlocks", question_blocks AS "questionBlocks",
  CASE WHEN status = 'pending' AND lease_until <= clock_timestamp()
       THEN CASE WHEN attempt < ${maxAttempts} THEN 'retryable' ELSE 'failed' END
       ELSE status END AS status, material_context AS "materialContext", explanation_source AS "explanationSource",
       review_invitation_id AS "reviewInvitationId", kind`;
const lease = "clock_timestamp() + interval '90 seconds'";

type StoredUserTurn = Omit<UserConversationTurn, "materialContext" | "explanationSource"> & {
  reviewInvitationId: string | null;
  materialContext: ConversationMaterialContext | null;
  explanationSource: UserConversationTurn["explanationSource"] | null;
};
type StoredTurn = StoredUserTurn | (Omit<ReviewQuestionTurn, "reviewInvitationId"> & { reviewInvitationId: string | null });

function unavailableBlocks(blocks: ConversationContent): ConversationContent {
  return blocks.map(({ id }) => ({ kind: "unavailable", id }));
}

function publicTurn(row: StoredTurn, reviewAvailable = true): ConversationTurn {
  const { requestId, kind, status } = row;
  if (kind === "review_question") {
    return {
      requestId, kind, status,
      questionBlocks: reviewAvailable ? row.questionBlocks : unavailableBlocks(row.questionBlocks),
      ...(reviewAvailable && row.reviewInvitationId ? { reviewInvitationId: row.reviewInvitationId } : {}),
    };
  }
  const { messageText, replyBlocks, materialContext, explanationSource } = row;
  return {
    requestId, kind, status, messageText,
    replyBlocks: !reviewAvailable && replyBlocks ? unavailableBlocks(replyBlocks) : replyBlocks,
    ...(materialContext ? { materialContext } : {}),
    ...(explanationSource ? { explanationSource } : {}),
  };
}

// Follow reply links so resuming an earlier question cannot import evidence or messages from a sibling discussion.
export async function readDiscussion(db: Pool | PoolClient, userId: string, requestId: string): Promise<ConversationTurn[]> {
  const turns = await db.query<StoredTurn>(`
    ${discussionChain}
    SELECT ${columns}
    FROM chain ORDER BY position
  `, [userId, requestId]);
  return turns.rows.map(row => publicTurn(row));
}

export async function readTurns(db: PoolClient, userId: string, conversationId: string): Promise<ConversationTurn[]> {
  const result = await db.query<StoredTurn>(`
    SELECT ${columns} FROM conversation_turns WHERE user_id = $1 AND conversation_id = $2 ORDER BY position
  `, [userId, conversationId]);
  const ids = [...new Set(result.rows.flatMap(row => row.reviewInvitationId ? [row.reviewInvitationId] : []))];
  const available = new Set((await readReviewInvitations(db, userId, ids)).map(review => review.reviewInvitationId));
  return result.rows.map(row => publicTurn(row, !row.reviewInvitationId || available.has(row.reviewInvitationId)));
}

type Claim = { attempt: number; deadline: Date };
type Receipt =
  | { kind: "conflict"; message: string }
  | { kind: "existing"; turn: ConversationTurn; attempt: number }
  | { kind: "invalid_material" | "invalid_review" }
  | ({ kind: "claimed"; materialContext?: ConversationMaterialContext; reviewInvitationId?: string } & Claim);

export function receiveTurn(pool: Pool, userId: string, command: SendConversationCommand): Promise<Receipt> {
  const { conversationId, requestId, messageText, materialSelection, reviewInvitationId } = command;
  return inTransaction(pool, async db => {
    // Serialize receipts for this user. The lock ends before model generation.
    await db.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    const params = [userId, requestId];
    const existing = (await db.query<StoredTurn & { matches: boolean; attempt: number; conversationId: string }>(`
      SELECT ${columns}, attempt, conversation_id AS "conversationId", ($3::jsonb IS NULL OR material_selection = $3::jsonb) AS matches
      FROM conversation_turns WHERE user_id = $1 AND request_id = $2 FOR UPDATE
    `, [...params, materialSelection ?? null])).rows[0];

    if (existing) {
      if (existing.kind !== "user" || existing.conversationId !== conversationId || existing.messageText !== messageText
        || !existing.matches || (reviewInvitationId && reviewInvitationId !== existing.reviewInvitationId)) {
        return { kind: "conflict", message: "这条消息已保存，修改内容后请作为新消息发送。" };
      }
      if (existing.status !== "retryable") {
        const available = !existing.reviewInvitationId || (await readReviewInvitations(db, userId, [existing.reviewInvitationId])).length > 0;
        return { kind: "existing", turn: publicTurn(existing, available), attempt: existing.attempt };
      }
      const retry = await db.query<Claim>(`
        UPDATE conversation_turns SET status = 'pending', lease_until = ${lease}, attempt = attempt + 1
        WHERE user_id = $1 AND request_id = $2 RETURNING attempt, lease_until AS deadline
      `, params);
      return { kind: "claimed", ...retry.rows[0]!, materialContext: existing.materialContext ?? undefined, reviewInvitationId: existing.reviewInvitationId ?? undefined };
    }

    // Each conversation has at most one reply in progress. Other conversations of the same user are independent.
    const open = (await db.query<StoredTurn>(`
      SELECT ${columns} FROM conversation_turns
      WHERE user_id = $1 AND conversation_id = $2 AND status IN ('pending', 'retryable') FOR UPDATE
    `, [userId, conversationId])).rows[0];
    if (open?.status === "pending") {
      return { kind: "conflict", message: "上一条消息正在回复。请稍后再发送。" };
    }

    const selection = materialSelection ?? (reviewInvitationId ? undefined : namedMaterial(messageText));
    const materialContext = selection ? await resolveMaterialContext(db, userId, conversationId, requestId, selection) : null;
    if (selection && !materialContext) return { kind: "invalid_material" };
    if (reviewInvitationId && !await canAnswerReview(db, userId, conversationId, reviewInvitationId)) return { kind: "invalid_review" };
    if (open) {
      // Close the previous retry before advancing the conversation.
      await db.query(`
        UPDATE conversation_turns SET status = 'failed', lease_until = NULL WHERE user_id = $1 AND request_id = $2
      `, [userId, open.requestId]);
    }
    await touchConversation(db, userId, conversationId, messageText);
    const inserted = await db.query<Claim>(`
      INSERT INTO conversation_turns (user_id, conversation_id, request_id, message_text, status, lease_until, material_selection, material_context, review_invitation_id)
      VALUES ($1, $7, $2, $3, 'pending', ${lease}, $4, $5, $6)
      RETURNING attempt, lease_until AS deadline
    `, [...params, messageText, selection ?? null, materialContext, reviewInvitationId ?? null, conversationId]);
    return { kind: "claimed", ...inserted.rows[0]!, materialContext: materialContext ?? undefined, reviewInvitationId };
  });
}

// A review answer belongs right after its question in the same conversation.
async function canAnswerReview(db: PoolClient, userId: string, conversationId: string, reviewInvitationId: string) {
  const { rows: [latest] } = await db.query<{ request_id: string }>(`
    SELECT request_id FROM conversation_turns WHERE user_id = $1 AND conversation_id = $2 ORDER BY position DESC LIMIT 1
  `, [userId, conversationId]);
  const [review] = await readReviewInvitations(db, userId, [reviewInvitationId]);
  return !!latest && review?.questionRequestId === latest.request_id;
}

export interface TurnMemory {
  memoryRevision: number;
  guarded: boolean;
  memoryIds: string[];
  summarySourceRequestIds: string[];
}

async function currentTurn(db: Pool | PoolClient, userId: string, requestId: string) {
  const result = await db.query<StoredTurn>(`
    SELECT ${columns} FROM conversation_turns WHERE user_id = $1 AND request_id = $2
  `, [userId, requestId]);
  const row = result.rows[0];
  if (!row) return null;
  const available = !row.reviewInvitationId || (await readReviewInvitations(db, userId, [row.reviewInvitationId])).length > 0;
  return publicTurn(row, available);
}

export async function stopActiveTurn(pool: Pool, userId: string, requestId: string) {
  const stopped = await pool.query<StoredTurn & { attempt: number }>(`
    UPDATE conversation_turns SET status = 'stopped', lease_until = NULL
    WHERE user_id = $1 AND request_id = $2 AND status = 'pending' AND lease_until > clock_timestamp()
    RETURNING ${columns}, attempt
  `, [userId, requestId]);
  const row = stopped.rows[0];
  if (row) return { turn: publicTurn(row), stoppedAttempt: row.attempt };
  return { turn: await currentTurn(pool, userId, requestId) };
}

export async function isActiveAttempt(pool: Pool, userId: string, requestId: string, attempt: number) {
  const result = await pool.query(`
    SELECT 1 FROM conversation_turns WHERE user_id = $1 AND request_id = $2 AND attempt = $3
    AND status = 'pending' AND lease_until > clock_timestamp()
  `, [userId, requestId, attempt]);
  return result.rowCount === 1;
}

export interface PublishOptions {
  memory?: TurnMemory;
  reviewInvitationId?: string;
  now?: Date;
  // Memory suggestions need an online model, so guided replies do not queue extraction work.
  extractMemories?: boolean;
}

export function publishTurn(
  pool: Pool, userId: string, requestId: string, attempt: number, output: TurnReply | null,
  { memory, reviewInvitationId, now = new Date(), extractMemories = false }: PublishOptions = {},
) {
  return inTransaction(pool, async db => {
    const result = await db.query<{ memory_revision: number }>(
      "SELECT memory_revision FROM users WHERE id = $1 FOR UPDATE", [userId],
    );
    const memoryRevision = result.rows[0]?.memory_revision;
    const invalidMemory = !!(output && memory?.guarded && (memory.memoryRevision !== memoryRevision
      || !await memoriesAreActive(db, userId, memory.memoryIds)));
    const review = reviewInvitationId ? (await readReviewInvitations(db, userId, [reviewInvitationId]))[0] : undefined;
    if (invalidMemory || (reviewInvitationId && !review)) output = null;
    const replyBlocks = output && conversationContentSchema.parse(output.replyBlocks.map(block => ({ ...block, id: randomUUID() })));
    const params = [userId, requestId, attempt, replyBlocks ? JSON.stringify(replyBlocks) : null, output?.explanationSource ?? null,
      !!(reviewInvitationId && !review), !!(review && output && !output.explanationSource)];
    const published = await db.query<StoredUserTurn>(`
      UPDATE conversation_turns SET reply_blocks = $4, explanation_source = $5, lease_until = NULL,
        review_invitation_id = CASE WHEN $7 THEN NULL ELSE review_invitation_id END,
        status = CASE WHEN $4::jsonb IS NOT NULL THEN 'complete'
                      WHEN $6 THEN 'failed'
                      WHEN attempt < ${maxAttempts} THEN 'retryable' ELSE 'failed' END
      WHERE user_id = $1 AND request_id = $2 AND attempt = $3
        AND status = 'pending' AND lease_until > clock_timestamp()
      RETURNING ${columns}
    `, params);
    if (published.rows[0]) {
      if (replyBlocks && memory) await recordMemoryUse(db, userId, requestId, memory, memoryRevision);
      if (replyBlocks && extractMemories) await enqueueExtraction(db, userId, requestId);
      const discussionVersion = review?.discussionVersion ?? published.rows[0].materialContext?.discussionVersion;
      if (output?.review && discussionVersion) {
        await scheduleReviewInvitation(db, userId, requestId, review?.originRequestId ?? requestId, discussionVersion, output.review, now);
      }
      return { turn: publicTurn(published.rows[0]), outcome: invalidMemory ? "memory_invalidated" : "written" } as const;
    }

    const turn = await currentTurn(db, userId, requestId);
    if (!turn) throw new Error("Conversation receipt missing");
    return { turn, outcome: turn.status === "stopped" ? "stopped" : "stale_attempt" } as const;
  });
}

async function memoriesAreActive(db: PoolClient, userId: string, ids: string[]) {
  if (!ids.length) return true;
  const result = await db.query(`
    SELECT id FROM personal_memories WHERE user_id = $1 AND id = ANY($2::uuid[]) AND body IS NOT NULL
    AND authorized_for_tutoring AND (expires_at IS NULL OR expires_at > clock_timestamp())
  `, [userId, ids]);
  return result.rowCount === ids.length;
}

async function recordMemoryUse(db: PoolClient, userId: string, requestId: string, memory: TurnMemory, memoryRevision: number) {
  if (memory.memoryIds.length) {
    await db.query(`
      INSERT INTO conversation_memory_sources (user_id, request_id, memory_id)
      SELECT $1, $2, unnest($3::uuid[])
    `, [userId, requestId, memory.memoryIds]);
  }
  if (memory.memoryRevision === memoryRevision && memory.summarySourceRequestIds.length) {
    await enqueueSummary(db, userId, memoryRevision, memory.summarySourceRequestIds);
  }
}
