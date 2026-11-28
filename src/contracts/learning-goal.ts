import { z } from 'zod'

export const learningGoalStatuses = ['active', 'paused', 'done'] as const
export const learningGoalLimit = 20
export const activeLearningGoalLimit = 5
export const goalTitleLimit = 40
export const goalNoteLimit = 200

const clean = (max: number) => z.string().trim().max(max).refine(text => !/[\u0000-\u0008\u000b-\u001f\uD800-\uDFFF]/u.test(text))
const id = z.uuid().toLowerCase()
const fields = {
  title: clean(goalTitleLimit).refine(title => title.length > 0),
  motivation: clean(goalNoteLimit),
  progress: clean(goalNoteLimit),
  status: z.enum(learningGoalStatuses),
}

export const learningGoalCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'), commandId: id, ...fields,
    // The Agent proposal this goal was accepted from.
    proposal: z.strictObject({ requestId: id, blockId: id }).optional(),
  }),
  z.strictObject({ operation: z.literal('update'), commandId: id, id, expectedRevision: z.int().positive().max(2147483647), ...fields }),
  z.strictObject({ operation: z.literal('delete'), commandId: id, id, expectedRevision: z.int().positive().max(2147483647) }),
])
export type LearningGoalCommand = z.infer<typeof learningGoalCommandSchema>

export interface LearningGoal {
  id: string
  revision: number
  title: string
  motivation: string
  progress: string
  status: typeof learningGoalStatuses[number]
  // The proposal block this goal was accepted from, so every device marks that proposal as taken.
  proposalBlockId: string | null
  updatedAt: string
}

export interface LearningGoalList {
  goals: LearningGoal[]
}
