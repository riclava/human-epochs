import type { Pool, PoolClient } from "pg";
import type { TodayPending, TodayReview, TodayView } from "../contracts/today.js";
import { readDueReviewInvitation } from "../review/invitations.js";
import { inTransaction } from "../storage/transaction.js";
import { listConversations } from "./conversation/conversations.js";
import { readLearningGoals } from "./learning-goals.js";

const pendingLimit = 5;

async function dueReview(db: PoolClient, userId: string, now: Date): Promise<TodayReview | null> {
  const invitation = await readDueReviewInvitation(db, userId, now);
  if (!invitation) return null;
  const { rows: [origin] } = await db.query<{ conversationId: string; title: string }>(`
    SELECT c.id AS "conversationId", c.title FROM review_invitations r
    JOIN conversation_turns t ON t.user_id = r.user_id AND t.request_id = r.origin_request_id
    JOIN conversations c ON c.user_id = t.user_id AND c.id = t.conversation_id
    WHERE r.user_id = $1 AND r.id = $2
  `, [userId, invitation.reviewInvitationId]);
  if (!origin) return null;
  return { reviewInvitationId: invitation.reviewInvitationId, topic: invitation.topic, sourceLabel: invitation.sourceLabel,
    conversationId: origin.conversationId, conversationTitle: origin.title };
}

type ProposalRow = { conversationId: string; requestId: string; block: { kind: string; id: string; title?: string; progress?: string; goalId?: string } };

// Proposals from the last week that are still open, newest first. A progress proposal counts only while its goal is
// active, still reads differently, and no newer proposal for that goal came after it.
async function openProposals(db: PoolClient, userId: string, goals: Awaited<ReturnType<typeof readLearningGoals>>["goals"]) {
  const { rows } = await db.query<ProposalRow>(`
    SELECT t.conversation_id AS "conversationId", t.request_id AS "requestId", block
    FROM conversation_turns t
    JOIN conversations c ON c.user_id = t.user_id AND c.id = t.conversation_id
    CROSS JOIN LATERAL jsonb_array_elements(t.reply_blocks) AS block
    WHERE t.user_id = $1 AND t.status = 'complete' AND c.updated_at > clock_timestamp() - interval '7 days'
      AND block->>'kind' IN ('goal_proposal', 'goal_progress_proposal')
    ORDER BY t.position DESC LIMIT 50
  `, [userId]);
  const seenGoals = new Set<string>();
  const items: TodayPending[] = [];
  for (const { conversationId, requestId, block } of rows) {
    if (block.kind === "goal_proposal") {
      if (goals.some(goal => goal.proposalBlockId === block.id || goal.title === block.title)) continue;
      items.push({ kind: "goal_proposal", conversationId, requestId, text: block.title! });
      continue;
    }
    if (seenGoals.has(block.goalId!)) continue;
    seenGoals.add(block.goalId!);
    const goal = goals.find(item => item.id === block.goalId);
    if (goal?.status === "active" && goal.progress !== block.progress) {
      items.push({ kind: "goal_progress", conversationId, requestId, text: `${goal.title}：${block.progress}` });
    }
  }
  return items;
}

async function memoryCandidates(db: PoolClient, userId: string): Promise<TodayPending[]> {
  const { rows } = await db.query<{ conversationId: string; requestId: string; body: string }>(`
    SELECT t.conversation_id AS "conversationId", c.source_request_id AS "requestId", c.body
    FROM personal_memory_candidates c
    JOIN conversation_turns t ON t.user_id = c.user_id AND t.request_id = c.source_request_id
    JOIN users u ON u.id = c.user_id AND u.memory_suggestions_enabled
    WHERE c.user_id = $1 AND c.status = 'pending' ORDER BY c.created_at DESC, c.id LIMIT ${pendingLimit}
  `, [userId]);
  return rows.map(row => ({ kind: "memory_candidate" as const, conversationId: row.conversationId, requestId: row.requestId, text: row.body }));
}

export function readToday(pool: Pool, userId: string, now: Date): Promise<TodayView> {
  return inTransaction(pool, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const { goals } = await readLearningGoals(db, userId);
    const pending = [...await openProposals(db, userId, goals), ...await memoryCandidates(db, userId)].slice(0, pendingLimit);
    return {
      review: await dueReview(db, userId, now),
      goals: goals.filter(goal => goal.status === "active").map(goal => ({
        id: goal.id, title: goal.title, progress: goal.progress, dueReviews: goal.activity.dueReviews,
        latestResult: goal.activity.latestResult, conversationId: goal.activity.conversations[0]?.id ?? null,
      })),
      pending,
      recentConversations: (await listConversations(db, userId)).conversations.slice(0, 3),
    };
  });
}
