import { z } from 'zod'

export const hqTaskInputSchema = z.object({
  title:z.string().trim().min(3).max(200),
  description:z.string().trim().max(10000),
  projectId:z.number().int().positive().optional(),
  projectKey:z.enum(['babyhub','babysential','brrrr','shared']),
  sourceIds:z.array(z.string().min(1).max(100)).min(1).max(20).transform(ids => [...new Set(ids)]),
  acceptanceCriteria:z.array(z.string().trim().min(3).max(500)).min(1).max(10),
  expectedOutcome:z.string().trim().min(3).max(2000),
  priority:z.enum(['low','medium','high','urgent']),
  idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{16,100}$/),
}).strict()
