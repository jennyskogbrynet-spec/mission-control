import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/)
const modelId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,199}$/)
const modelIds = z.array(modelId).max(64).refine(values => new Set(values).size === values.length, 'Duplicate model IDs')
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/).nullable()
const timestamp = z.string().datetime({ offset: true })
const label = z.string().trim().min(1).max(200)
const ids = z.array(id).max(64).refine(values => new Set(values).size === values.length, 'Duplicate identifiers')
const billingMode = z.enum(['subscription', 'api', 'local', 'unknown'])
const dataClass = z.enum(['public', 'internal', 'restricted'])
const source = z.object({
  kind: z.enum(['provider_api', 'cli', 'browser', 'manual', 'import']), label,
  evidenceRef: z.string().max(500).optional().refine(value => {
    if (!value || !/^https?:/i.test(value)) return true
    try { const url = new URL(value); return !url.username && !url.password } catch { return false }
  }, 'Credential-bearing URLs are not evidence references'),
}).strict()
export const computeAccountSchema = z.object({
  id, label, provider: id, plan: label, billingMode, enabled: z.boolean().default(true),
  monthlyCost: z.number().finite().nonnegative().nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  identityFingerprint: fingerprint.optional(),
}).strict()
export const computePoolSchema = z.object({ id, accountId: id, key: id, label, modelIds, windowKeys: ids.refine(values => values.length > 0, 'Expected quota windows are required') }).strict()
export const computeBindingSchema = z.object({
  id, accountId: id, runtimeId: id, profileRef: id, modelIds: modelIds.refine(values => values.length > 0), capabilities: ids,
  poolIds: ids, dataClasses: z.array(dataClass).min(1).max(3), enabled: z.boolean().default(true),
  modelCapabilities: z.array(z.object({
    modelId, tier: z.enum(['fast', 'balanced', 'deep']), capabilities: ids, notes: z.string().max(1000),
    verifiedAt: timestamp.nullable(), evidence: z.string().max(500),
  }).strict()).max(64),
}).strict().refine(value => new Set(value.modelCapabilities.map(model => model.modelId)).size === value.modelCapabilities.length && value.modelCapabilities.every(model => value.modelIds.includes(model.modelId)), 'Model capability entries must match distinct model IDs')
const window = z.object({
  key: id, label, usedPercent: z.number().finite().min(0).max(100).nullable().optional(), remainingPercent: z.number().finite().min(0).max(100).nullable().optional(),
  limit: z.number().finite().nonnegative().nullable().optional(), used: z.number().finite().nonnegative().nullable().optional(),
  unit: id, resetsAt: timestamp.nullable(),
}).strict().refine(value => value.usedPercent == null || value.remainingPercent == null || Math.abs(value.usedPercent + value.remainingPercent - 100) < 0.01, 'Conflicting quota percentages')
const base = { externalId: z.string().uuid(), observedAt: timestamp, source, status: z.enum(['success', 'failed', 'login_required']), error: z.string().max(1000).optional() }
export const computeObservationSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('quota'), accountId: id, poolId: id, windows: z.array(window).max(32).refine(values => new Set(values.map(item => item.key)).size === values.length, 'Duplicate quota windows') }).strict(),
  z.object({ ...base, kind: z.literal('access'), accountId: id, bindingId: id.nullable().optional(), identityFingerprint: fingerprint, identityVerified: z.boolean(), entitlementVerified: z.boolean() }).strict(),
  z.object({ ...base, kind: z.literal('reset'), accountId: id, available: z.number().int().nonnegative().nullable(), event: z.enum(['availability', 'redeemed']), note: z.string().max(500).optional() }).strict(),
  z.object({ ...base, kind: z.literal('collector'), enabled: z.boolean(), intervalHours: z.number().finite().positive().max(168).nullable(), nextDueAt: timestamp.nullable(), jobRef: id.nullable() }).strict(),
])
export const computeMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('upsert_account'), account: computeAccountSchema }).strict(),
  z.object({ action: z.literal('upsert_pool'), pool: computePoolSchema }).strict(),
  z.object({ action: z.literal('upsert_binding'), binding: computeBindingSchema }).strict(),
  z.object({ action: z.literal('record_observation'), observation: computeObservationSchema }).strict(),
])
export const computeRecommendationSchema = z.object({
  projectId: z.number().int().positive().optional(), requiredCapabilities: ids, difficulty: z.enum(['routine', 'standard', 'complex']), dataClass,
  ready: z.boolean(), valuable: z.boolean(), reservePercent: z.number().finite().min(0).max(90).default(20),
  allowedBillingModes: z.array(billingMode).min(1).max(4).default(['subscription', 'local']),
}).strict()
export type ComputeMutation = z.infer<typeof computeMutationSchema>
