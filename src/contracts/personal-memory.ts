import { z } from 'zod'

export const personalMemoryKindSchema = z.enum(['statement', 'inference', 'wish'])
export const personalMemoryBodyLimit = 1200

const cleanText = (max: number) => z.string().trim().max(max).refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text))
const editable = {
  kind: personalMemoryKindSchema,
  body: cleanText(personalMemoryBodyLimit).refine(text => text.length > 0),
  topic: cleanText(120),
  authorizedForTutoring: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
}
const details = { ...editable, sourceRequestId: z.uuid().toLowerCase().optional() }
const commandId = z.uuid().toLowerCase()
const existing = { id: z.uuid().toLowerCase(), expectedRevision: z.int().positive().max(2147483647), commandId }
const candidateId = z.uuid().toLowerCase()

export const personalMemoryCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('remember'), commandId, ...details }),
  z.strictObject({ operation: z.literal('correct'), ...existing, ...details }),
  z.strictObject({ operation: z.literal('forget'), ...existing }),
  // The source comes from the stored candidate, so a client cannot attach an accepted candidate to another message.
  z.strictObject({ operation: z.literal('accept_candidate'), commandId, candidateId, ...editable }),
  z.strictObject({ operation: z.literal('reject_candidate'), commandId, candidateId }),
  z.strictObject({ operation: z.literal('set_suggestions'), commandId, enabled: z.boolean() }),
])

export type PersonalMemoryCommand = z.infer<typeof personalMemoryCommandSchema>
export type PersonalMemoryKind = z.infer<typeof personalMemoryKindSchema>

export interface PersonalMemory {
  id: string
  revision: number
  kind: PersonalMemoryKind
  body: string
  topic: string
  authorizedForTutoring: boolean
  expiresAt: string | null
  sourceRequestId: string | null
}

export interface PersonalMemoryCandidate {
  id: string
  kind: PersonalMemoryKind
  body: string
  quote: string
  reason: string
  topic: string
  suggestedForTutoring: boolean
  sourceRequestId: string
}

export interface PersonalMemorySnapshot {
  memories: PersonalMemory[]
  candidates: PersonalMemoryCandidate[]
  suggestionsEnabled: boolean
  suggestionsPending: boolean
}

export const memoryCandidateLimit = 3
export const memoryCandidateSchema = z.strictObject({
  kind: personalMemoryKindSchema,
  body: cleanText(personalMemoryBodyLimit).refine(text => text.length > 0),
  quote: cleanText(300).refine(text => text.length > 0),
  reason: cleanText(200).refine(text => text.length > 0),
  topic: cleanText(120),
  tutoring: z.boolean(),
})
export const memoryExtractionSchema = z.strictObject({
  candidates: z.array(memoryCandidateSchema).max(memoryCandidateLimit),
})
export type MemoryExtraction = z.infer<typeof memoryExtractionSchema>
