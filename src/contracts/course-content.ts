import { z } from "zod";

const text = z.string().refine(value => value.trim().length > 0, "Expected non-blank text");

const evidenceMaterial = z.strictObject({ id: text, label: text, text });
export const CourseContentSchema = z.strictObject({
  title: text, goal: text, prompt: text,
  materials: z.array(evidenceMaterial).min(1),
  clarifications: z.array(z.strictObject({ terms: z.array(text).min(1), text })),
});

export type CourseContent = z.infer<typeof CourseContentSchema>;
