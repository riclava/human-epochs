import { z } from "zod";
import { CourseContentSchema } from "./activity-types.js";

const text = z.string().refine(value => value.trim().length > 0, "Expected non-blank text");
const id = z.uuid().toLowerCase();
const activityTarget = {
  activityId: id,
  revision: z.int().positive().max(2147483647),
};

export const ActivityViewSchema = z.strictObject({
  ...activityTarget,
  ...CourseContentSchema.shape,
  activityVersion: text,
  allowedActions: z.tuple([z.literal("view"), z.literal("requestHint").optional()]),
  hints: z.array(text),
});

export const RequestHintCommandSchema = z.strictObject({ ...activityTarget, commandId: id });
export const RequestHintResultSchema = z.strictObject({ hint: text, activity: ActivityViewSchema });

export type ActivityView = z.infer<typeof ActivityViewSchema>;
export type RequestHintCommand = z.infer<typeof RequestHintCommandSchema>;
export type RequestHintResult = z.infer<typeof RequestHintResultSchema>;
