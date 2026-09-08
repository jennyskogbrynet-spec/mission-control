import { z } from 'zod'

// Shared by the HTTP boundary and both evidence form actions. URL safety remains
// enforced by recordHQEvidence; this extraction preserves the route's semantics.
export const hqEvidenceInputSchema = z.object({
  label: z.string().trim().min(3).max(160),
  detail: z.string().trim().min(3).max(6000),
  url: z.string().trim().max(2048).optional(),
  saveLearning: z.boolean().optional(),
}).strict()
