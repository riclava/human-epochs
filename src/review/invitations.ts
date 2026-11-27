import type { Pool, PoolClient } from "pg";
import type { ConversationSource, ReviewInvitationCommand, ReviewInvitation } from "../contracts/conversation.js";
import { publishedDiscussions } from "../courses/catalog.js";
import type { ReviewProposal } from "./proposal.js";

interface StoredReviewInvitation {
  reviewInvitationId: string;
  originRequestId: string;
  proposal: ReviewProposal;
  questionRequestId: string | null;
  discussionVersion: string | null;
  sources: SavedSource[];
  conversationTitle: string | null;
}

const reviewRows = `
  SELECT r.id AS "reviewInvitationId", r.origin_request_id AS "originRequestId", r.proposal,
    r.question_request_id AS "questionRequestId", origin.material_context->>'discussionVersion' AS "discussionVersion",
    origin.material_context->'sources' AS sources, conversation.title AS "conversationTitle"
  FROM review_invitations r
  JOIN conversation_turns origin ON origin.user_id = r.user_id AND origin.request_id = r.origin_request_id
  JOIN conversation_turns evidence ON evidence.user_id = r.user_id AND evidence.request_id = r.id
  LEFT JOIN conversations conversation ON conversation.user_id = r.user_id AND conversation.id = origin.conversation_id
  WHERE r.user_id = $1 AND NOT r.cancelled AND origin.status = 'complete' AND evidence.status = 'complete'
    AND NOT origin.reply_blocks @> '[{"kind":"unavailable"}]'
    AND NOT evidence.reply_blocks @> '[{"kind":"unavailable"}]'`;

// A discussion's saved source. Course sources keep their text; a source the user attached keeps only a reference.
export type SavedSource = { id: string; label: string; text?: string };

// A course source must still match the published course, so a course update retires reviews of old wording.
// A source the user brought (an "excerpt:" ID) lives in the material store and is checked by its ID; a course
// source that is no longer published is not valid.
export function reviewSourceValid(discussionVersion: string | null, source: SavedSource) {
  const discussion = publishedDiscussions.find(item => item.discussionVersion === discussionVersion);
  const published = discussion && [...discussion.sources, ...discussion.supplements].find(item => item.id === source.id);
  if (published) return source.text === undefined || (published.label === source.label && published.text === source.text);
  return source.id.startsWith("excerpt:");
}

// The review's evidence must come from one of the sources its discussion read. Course evidence is the whole course
// source and must equal the saved one; the user's own evidence is the passage around the quote.
export function reviewSourceAvailable(discussionVersion: string | null, sources: SavedSource[] | undefined, evidence: ConversationSource) {
  const saved = sources?.find(candidate => candidate.id === evidence.id);
  if (!saved || saved.label !== evidence.label) return false;
  if (saved.text !== undefined && saved.text !== evidence.text) return false;
  return reviewSourceValid(discussionVersion, evidence.id.startsWith("excerpt:") ? { id: evidence.id, label: evidence.label } : evidence);
}

function sourceAvailable(review: StoredReviewInvitation) {
  return reviewSourceAvailable(review.discussionVersion, review.sources, review.proposal.source);
}

export async function readReviewInvitations(db: Pool | PoolClient, userId: string, ids: string[]) {
  if (!ids.length) return [];
  const result = await db.query<StoredReviewInvitation>(reviewRows + " AND r.id = ANY($2::uuid[])", [userId, ids]);
  return result.rows.filter(sourceAvailable);
}

export async function readDueReviewInvitation(db: PoolClient, userId: string, now: Date): Promise<ReviewInvitation | undefined> {
  const result = await db.query<StoredReviewInvitation>(reviewRows + ` AND r.question_request_id IS NULL AND r.due_at <= $2
    AND EXISTS (SELECT 1 FROM users WHERE id = $1 AND review_reminders_enabled)`, [userId, now]);
  const review = result.rows.find(sourceAvailable);
  if (review) return { reviewInvitationId: review.reviewInvitationId, topic: review.proposal.topic, sourceLabel: review.proposal.source.label,
    conversationTitle: review.conversationTitle };
}

export async function reviewRemindersEnabled(db: PoolClient, userId: string) {
  const { rows: [user] } = await db.query<{ reviewRemindersEnabled: boolean }>(
    'SELECT review_reminders_enabled AS "reviewRemindersEnabled" FROM users WHERE id = $1', [userId],
  );
  return user?.reviewRemindersEnabled === true;
}

export async function scheduleReviewInvitation(
  db: PoolClient, userId: string, evidenceId: string, originRequestId: string,
  discussion: { discussionVersion: string | null; sources: SavedSource[] }, proposal: ReviewProposal, now: Date,
) {
  if (!reviewSourceAvailable(discussion.discussionVersion, discussion.sources, proposal.source) || !await reviewRemindersEnabled(db, userId)) return;
  const { rowCount: stopped } = await db.query(
    "SELECT 1 FROM review_topic_stops WHERE user_id = $1 AND origin_request_id = $2", [userId, originRequestId],
  );
  if (stopped) return;
  const { rows: [pending] } = await db.query<{ id: string }>(`
    SELECT id FROM review_invitations WHERE user_id = $1 AND question_request_id IS NULL AND NOT cancelled
  `, [userId]);
  if (pending) {
    if ((await readReviewInvitations(db, userId, [pending.id])).length) return;
    await db.query('UPDATE review_invitations SET cancelled = true WHERE user_id = $1 AND id = $2', [userId, pending.id]);
  }
  const dueAt = new Date(now.getTime() + proposal.afterDays * 86_400_000);
  await db.query(`
    INSERT INTO review_invitations (user_id, id, origin_request_id, due_at, proposal) VALUES ($1, $2, $3, $4, $5)
  `, [userId, evidenceId, originRequestId, dueAt, proposal]);
}

type CommandResult = "done" | "conflict" | "missing";

export async function applyReviewInvitationCommand(
  db: PoolClient, userId: string, command: ReviewInvitationCommand, now: Date,
  publishQuestion: (reviewInvitationId: string, question: string) => Promise<boolean>,
): Promise<CommandResult> {
  const { reviewInvitationId, commandId, action } = command;
  const { rows: [receipt] } = await db.query<{ matches: boolean }>(`
    SELECT review_invitation_id = $3 AND action = $4 AS matches FROM review_invitation_command_receipts
    WHERE user_id = $1 AND command_id = $2
  `, [userId, commandId, reviewInvitationId, action]);
  if (receipt) return receipt.matches ? "done" : "conflict";

  const { rows: [invitation] } = await db.query<{ due: boolean; cancelled: boolean; questionRequestId: string | null }>(`
    SELECT due_at <= $3 AS due, cancelled, question_request_id AS "questionRequestId"
    FROM review_invitations WHERE user_id = $1 AND id = $2
  `, [userId, reviewInvitationId, now]);
  if (!invitation) return "missing";
  const result = await updateInvitation(db, userId, command, invitation, now, publishQuestion);
  if (result === false) return "conflict";
  await db.query(`
    INSERT INTO review_invitation_command_receipts (user_id, command_id, review_invitation_id, action, question_request_id)
    VALUES ($1, $2, $3, $4, $5)
  `, [userId, commandId, reviewInvitationId, action, result]);
  return "done";
}

async function updateInvitation(
  db: PoolClient, userId: string, { action, reviewInvitationId, commandId }: ReviewInvitationCommand,
  invitation: { due: boolean; cancelled: boolean; questionRequestId: string | null }, now: Date,
  publishQuestion: (reviewInvitationId: string, question: string) => Promise<boolean>,
) {
  const params = [userId, reviewInvitationId];
  if (action === "stop") {
    await db.query('UPDATE users SET review_reminders_enabled = false WHERE id = $1', [userId]);
    await db.query('UPDATE review_invitations SET cancelled = true WHERE user_id = $1 AND question_request_id IS NULL AND NOT cancelled', [userId]);
    return null;
  }
  if (action === "accept" && invitation.questionRequestId) return invitation.questionRequestId;
  if (!invitation.due || invitation.cancelled || invitation.questionRequestId) return false;
  const [review] = await readReviewInvitations(db, userId, [reviewInvitationId]);
  if (!review) return false;
  if (action === "later") {
    await db.query('UPDATE review_invitations SET due_at = $3 WHERE user_id = $1 AND id = $2',
      [...params, new Date(now.getTime() + 86_400_000)]);
    return null;
  }
  if (!await publishQuestion(reviewInvitationId, review.proposal.question)) return false;
  await db.query('UPDATE review_invitations SET question_request_id = $3 WHERE user_id = $1 AND id = $2', [...params, commandId]);
  return commandId;
}
