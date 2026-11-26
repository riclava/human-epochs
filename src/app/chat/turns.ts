import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { chatContentSchema, type ChatMaterialContext, type ChatMaterialInput, type ChatTurn } from "../../contracts/chat.js";
import type { TurnReply } from "../../runtime/run-turn.js";
import { inTransaction } from "../../storage/transaction.js";
import { enqueueSummary } from "../memory/summaries.js";
import { discussionChain } from "./history.js";
import { materialContext } from "./materials.js";

const maxAttempts = 3;
const columns = `request_id AS "requestId", message_text AS text, content_blocks AS content,
  CASE WHEN status = 'pending' AND lease_until <= clock_timestamp()
       THEN CASE WHEN attempt < ${maxAttempts} THEN 'retryable' ELSE 'failed' END
       ELSE status END AS status, material_context AS material, explanation_mode AS "explanationMode"`;
const lease = "clock_timestamp() + interval '90 seconds'";

function publicTurn(row: ChatTurn): ChatTurn {
  const { requestId, text, content, status, material, explanationMode } = row;
  return { requestId, text, content, status, ...(material ? { material } : {}),
    ...(explanationMode ? { explanationMode } : {}) };
}

// Follow reply links so resuming an earlier question cannot import evidence or messages from a sibling discussion.
export async function readDiscussion(db: Pool | PoolClient, learnerId: string, requestId: string): Promise<ChatTurn[]> {
  const turns = await db.query<ChatTurn>(`
    ${discussionChain}
    SELECT request_id AS "requestId", message_text AS text, content_blocks AS content, status, material_context AS material, explanation_mode AS "explanationMode"
    FROM chain ORDER BY position
  `, [learnerId, requestId]);
  return turns.rows.map(publicTurn);
}

export async function readTurns(pool: Pool, learnerId: string): Promise<ChatTurn[]> {
  const result = await pool.query<ChatTurn>(`
    SELECT ${columns} FROM chat_turns WHERE learner_id = $1 ORDER BY position
  `, [learnerId]);
  return result.rows.map(publicTurn);
}

type Claim = { attempt: number; deadline: Date };
type Receipt =
  | { kind: "conflict"; message: string }
  | { kind: "existing"; turn: ChatTurn; attempt: number }
  | { kind: "invalid_material" }
  | ({ kind: "claimed"; material?: ChatMaterialContext } & Claim);

export function receiveTurn(
  pool: Pool, learnerId: string, requestId: string, text: string, input?: ChatMaterialInput,
): Promise<Receipt> {
  return inTransaction(pool, async db => {
    // Serialize receipts for this learner. The lock ends before model generation.
    await db.query("SELECT id FROM learners WHERE id = $1 FOR UPDATE", [learnerId]);
    const params = [learnerId, requestId];
    const existing = (await db.query<ChatTurn & { matches: boolean; attempt: number }>(`
      SELECT ${columns}, attempt, ($3::jsonb IS NULL OR material_command = $3::jsonb) AS matches
      FROM chat_turns WHERE learner_id = $1 AND request_id = $2 FOR UPDATE
    `, [...params, input ?? null])).rows[0];

    if (existing) {
      if (existing.text !== text || !existing.matches) {
        return { kind: "conflict", message: "这条消息已保存，修改内容后请作为新消息发送。" };
      }
      if (existing.status !== "retryable") return { kind: "existing", turn: publicTurn(existing), attempt: existing.attempt };
      const retry = await db.query<Claim>(`
        UPDATE chat_turns SET status = 'pending', lease_until = ${lease}, attempt = attempt + 1
        WHERE learner_id = $1 AND request_id = $2 RETURNING attempt, lease_until AS deadline
      `, params);
      return { kind: "claimed", ...retry.rows[0]!, material: existing.material ?? undefined };
    }

    const open = (await db.query<ChatTurn>(`
      SELECT ${columns} FROM chat_turns
      WHERE learner_id = $1 AND status IN ('pending', 'retryable') FOR UPDATE
    `, [learnerId])).rows[0];
    if (open?.status === "pending") {
      return { kind: "conflict", message: "上一条消息正在回复。请稍后再发送。" };
    }

    const material = input ? await materialContext(db, learnerId, requestId, input) : null;
    if (input && !material) return { kind: "invalid_material" };
    if (open) {
      // Close the previous retry before advancing the conversation.
      await db.query(`
        UPDATE chat_turns SET status = 'failed', lease_until = NULL WHERE learner_id = $1 AND request_id = $2
      `, [learnerId, open.requestId]);
    }
    const inserted = await db.query<Claim>(`
      INSERT INTO chat_turns (learner_id, request_id, message_text, status, lease_until, material_command, material_context)
      VALUES ($1, $2, $3, 'pending', ${lease}, $4, $5)
      RETURNING attempt, lease_until AS deadline
    `, [...params, text, input ?? null, material]);
    return { kind: "claimed", ...inserted.rows[0]!, material: material ?? undefined };
  });
}

export interface TurnMemory {
  revision: number;
  guarded: boolean;
  memoryIds: string[];
  summarySources: string[];
}

async function currentTurn(db: Pool | PoolClient, learnerId: string, requestId: string) {
  const result = await db.query<ChatTurn>(`
    SELECT ${columns} FROM chat_turns WHERE learner_id = $1 AND request_id = $2
  `, [learnerId, requestId]);
  return result.rows[0] ? publicTurn(result.rows[0]) : null;
}

export async function stopActiveTurn(pool: Pool, learnerId: string, requestId: string) {
  const stopped = await pool.query<ChatTurn & { attempt: number }>(`
    UPDATE chat_turns SET status = 'stopped', lease_until = NULL
    WHERE learner_id = $1 AND request_id = $2 AND status = 'pending' AND lease_until > clock_timestamp()
    RETURNING ${columns}, attempt
  `, [learnerId, requestId]);
  const row = stopped.rows[0];
  if (row) return { turn: publicTurn(row), stoppedAttempt: row.attempt };
  return { turn: await currentTurn(pool, learnerId, requestId) };
}

export async function isActiveAttempt(pool: Pool, learnerId: string, requestId: string, attempt: number) {
  const result = await pool.query(`
    SELECT 1 FROM chat_turns WHERE learner_id = $1 AND request_id = $2 AND attempt = $3
    AND status = 'pending' AND lease_until > clock_timestamp()
  `, [learnerId, requestId, attempt]);
  return result.rowCount === 1;
}

export function publishTurn(
  pool: Pool, learnerId: string, requestId: string, attempt: number, output: TurnReply | null, memory?: TurnMemory,
) {
  return inTransaction(pool, async db => {
    const result = await db.query<{ memory_revision: number }>(
      "SELECT memory_revision FROM learners WHERE id = $1 FOR UPDATE", [learnerId],
    );
    const revision = result.rows[0]?.memory_revision;
    const invalidMemory = !!(output && memory?.guarded && (memory.revision !== revision
      || !await memoriesAreActive(db, learnerId, memory.memoryIds)));
    if (invalidMemory) output = null;
    const content = output && chatContentSchema.parse(output.content.map(block => ({ ...block, id: randomUUID() })));
    const params = [learnerId, requestId, attempt, content ? JSON.stringify(content) : null, output?.explanationMode ?? null];
    const published = await db.query<ChatTurn>(`
      UPDATE chat_turns SET content_blocks = $4, explanation_mode = $5, lease_until = NULL,
        status = CASE WHEN $4::jsonb IS NOT NULL THEN 'complete'
                      WHEN attempt < ${maxAttempts} THEN 'retryable' ELSE 'failed' END
      WHERE learner_id = $1 AND request_id = $2 AND attempt = $3
        AND status = 'pending' AND lease_until > clock_timestamp()
      RETURNING ${columns}
    `, params);
    if (published.rows[0]) {
      if (content && memory) await recordMemoryUse(db, learnerId, requestId, memory, revision);
      return { turn: publicTurn(published.rows[0]), outcome: invalidMemory ? "memory_invalidated" : "written" } as const;
    }

    const turn = await currentTurn(db, learnerId, requestId);
    if (!turn) throw new Error("Chat receipt missing");
    return { turn, outcome: turn.status === "stopped" ? "stopped" : "stale_attempt" } as const;
  });
}

async function memoriesAreActive(db: PoolClient, learnerId: string, ids: string[]) {
  if (!ids.length) return true;
  const result = await db.query(`
    SELECT id FROM personal_memories WHERE learner_id = $1 AND id = ANY($2::uuid[]) AND body IS NOT NULL
    AND authorized AND (expires_at IS NULL OR expires_at > clock_timestamp())
  `, [learnerId, ids]);
  return result.rowCount === ids.length;
}

async function recordMemoryUse(db: PoolClient, learnerId: string, requestId: string, memory: TurnMemory, revision: number) {
  if (memory.memoryIds.length) {
    await db.query(`
      INSERT INTO chat_memory_sources (learner_id, request_id, memory_id)
      SELECT $1, $2, unnest($3::uuid[])
    `, [learnerId, requestId, memory.memoryIds]);
  }
  if (memory.revision === revision && memory.summarySources.length) {
    await enqueueSummary(db, learnerId, revision, memory.summarySources);
  }
}
