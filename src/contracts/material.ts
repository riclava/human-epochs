import { z } from 'zod'

// A material in the user's library, as the "我的材料" page and the attach dialog list it.
export interface MaterialItem {
  id: string
  label: string
  length: number
  createdAt: string
  // How many conversations have read it.
  conversations: number
}

export interface MaterialLibrary {
  materials: MaterialItem[]
}

export const materialCommandSchema = z.strictObject({ operation: z.literal('delete'), materialId: z.uuid().toLowerCase() })
export type MaterialCommand = z.infer<typeof materialCommandSchema>
