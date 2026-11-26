import { z } from 'zod'

export const memoryKindSchema = z.enum(['statement', 'inference', 'wish'])
export const memoryBodyLimit = 1200

const cleanText = (max: number) => z.string().trim().max(max).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text))
const details = {
  kind: memoryKindSchema,
  body: cleanText(memoryBodyLimit).refine(text => text.length > 0),
  topic: cleanText(120),
  authorized: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  sourceRequestId: z.uuid().toLowerCase().optional(),
}
const commandId = z.uuid().toLowerCase()
const existing = { id: z.uuid().toLowerCase(), revision: z.int().positive().max(2147483647), commandId }

export const memoryCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('remember'), commandId, ...details }),
  z.strictObject({ operation: z.literal('correct'), ...existing, ...details }),
  z.strictObject({ operation: z.literal('forget'), ...existing }),
])

export type MemoryCommand = z.infer<typeof memoryCommandSchema>
export interface PersonalMemory {
  id: string
  revision: number
  kind: z.infer<typeof memoryKindSchema>
  body: string
  topic: string
  authorized: boolean
  expiresAt: string | null
  sourceRequestId: string | null
}

export interface MemorySnapshot {
  memories: PersonalMemory[]
}
