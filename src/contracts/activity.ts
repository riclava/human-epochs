import { z } from "zod";
import { CourseContentSchema } from "./course-content.js";

const text = z.string().refine(value => value.trim().length > 0, "Expected non-blank text");
const id = z.uuid().toLowerCase();
const revision = z.int().positive().max(2147483647);

export const ActivityViewSchema = z.strictObject({
  activityId: id,
  revision,
  ...CourseContentSchema.shape,
  courseVersion: text,
  allowedActions: z.tuple([z.literal("view"), z.literal("requestHint").optional()]),
  claimedHints: z.array(text),
});

export const RequestHintCommandSchema = z.strictObject({ activityId: id, expectedRevision: revision, commandId: id });
export const RequestHintResultSchema = z.strictObject({ hintText: text, activity: ActivityViewSchema });

export type ActivityView = z.infer<typeof ActivityViewSchema>;
export type RequestHintCommand = z.infer<typeof RequestHintCommandSchema>;
export type RequestHintResult = z.infer<typeof RequestHintResultSchema>;

export interface ActivityConversationTurn {
  requestId: string;
  expectedRevision: number;
  messageText: string;
  intent: "message" | "hint";
  replyText: string | null;
  status: "pending" | "complete" | "conflict";
}
