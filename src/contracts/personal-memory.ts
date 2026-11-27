import { z } from 'zod'

export const personalMemoryKindSchema = z.enum(['statement', 'inference', 'wish'])
export const personalMemoryBodyLimit = 1200

const cleanText = (max: number) => z.string().trim().max(max).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text))
const details = {
  kind: personalMemoryKindSchema,
  body: cleanText(personalMemoryBodyLimit).refine(text => text.length > 0),
  topic: cleanText(120),
  authorizedForTutoring: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  sourceRequestId: z.uuid().toLowerCase().optional(),
}
const commandId = z.uuid().toLowerCase()
const existing = { id: z.uuid().toLowerCase(), expectedRevision: z.int().positive().max(2147483647), commandId }

export const personalMemoryCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('remember'), commandId, ...details }),
  z.strictObject({ operation: z.literal('correct'), ...existing, ...details }),
  z.strictObject({ operation: z.literal('forget'), ...existing }),
])

export type PersonalMemoryCommand = z.infer<typeof personalMemoryCommandSchema>
export interface PersonalMemory {
  id: string
  revision: number
  kind: z.infer<typeof personalMemoryKindSchema>
  body: string
  topic: string
  authorizedForTutoring: boolean
  expiresAt: string | null
  sourceRequestId: string | null
}

export interface PersonalMemorySnapshot {
  memories: PersonalMemory[]
}
