export type ComputeBillingMode = 'subscription' | 'api' | 'local' | 'unknown'
export type ComputeFreshness = 'fresh' | 'refresh_due' | 'stale' | 'unknown'
export type ComputePoolStatus = 'ready' | 'refresh_required' | 'stale' | 'exhausted' | 'reset_unconfirmed' | 'unavailable' | 'unknown'
export type ComputeVerification = 'verified' | 'unverified' | 'unknown'
export type ComputeDifficulty = 'routine' | 'standard' | 'complex'
export type ComputeDataClass = 'public' | 'internal' | 'restricted'
export interface ComputeSource {
  kind: 'provider_api' | 'cli' | 'browser' | 'manual' | 'import'
  label: string
  evidenceRef?: string
}
export interface ComputeAccountDefinition {
  id: string; label: string; provider: string; plan: string; billingMode: ComputeBillingMode; enabled: boolean
  monthlyCost?: number | null; currency?: string | null
  identityFingerprint?: string | null
}
export interface ComputePoolDefinition {
  id: string; accountId: string; key: string; label: string; modelIds: string[]; windowKeys: string[]
}
export interface ComputeModelCapability {
  modelId: string; tier: 'fast' | 'balanced' | 'deep'; capabilities: string[]; notes: string
  verifiedAt: string | null; evidence: string
}
export interface ComputeBindingDefinition {
  id: string; accountId: string; runtimeId: string; profileRef: string; modelIds: string[]; capabilities: string[]
  poolIds: string[]; dataClasses: ComputeDataClass[]; enabled: boolean; modelCapabilities: ComputeModelCapability[]
}
export interface ComputeWindowInput {
  key: string; label: string; usedPercent?: number | null; remainingPercent?: number | null
  limit?: number | null; used?: number | null; unit: string; resetsAt: string | null
}
interface ObservationBase {
  externalId: string; observedAt: string; source: ComputeSource; status: 'success' | 'failed' | 'login_required'; error?: string
}
export type ComputeObservationInput = ObservationBase & (
  | { kind: 'quota'; accountId: string; poolId: string; windows: ComputeWindowInput[] }
  | { kind: 'access'; accountId: string; bindingId?: string | null; identityFingerprint: string | null; identityVerified: boolean; entitlementVerified: boolean }
  | { kind: 'reset'; accountId: string; available: number | null; event: 'availability' | 'redeemed'; note?: string }
  | { kind: 'collector'; enabled: boolean; intervalHours: number | null; nextDueAt: string | null; jobRef: string | null }
)
export interface ComputeWindow extends ComputeWindowInput {
  usedPercent: number | null; remainingPercent: number | null; limit: number | null; used: number | null
  observedAt: string; source: ComputeSource; freshness: ComputeFreshness
}
export interface ComputePool extends ComputePoolDefinition {
  windows: ComputeWindow[]; effectiveRemainingPercent: number | null; status: ComputePoolStatus
  observedAt: string | null; lastGoodObservedAt: string | null; source: ComputeSource | null
  observationId: string | null; lastObservationStatus: 'success' | 'failed' | 'login_required' | null; error: string | null
}
export interface ComputeBinding extends ComputeBindingDefinition {
  identityStatus: ComputeVerification; entitlementStatus: ComputeVerification; verifiedAt: string | null
  verificationFreshness: ComputeFreshness; source: ComputeSource | null; observationId: string | null
}
export interface ComputeAccount extends ComputeAccountDefinition {
  pools: ComputePool[]; status: 'ready' | 'login_required' | 'unknown' | 'disabled' | 'unavailable'
  observedAt: string | null; source: ComputeSource | null
  resetCredits: { available: number | null; observedAt: string; source: ComputeSource; freshness: ComputeFreshness; event: 'availability' | 'redeemed' } | null
}
export interface ComputeOverview {
  asOf: string; accounts: ComputeAccount[]; bindings: ComputeBinding[]; warnings: string[]
  refresh: { enabled: boolean; intervalHours: number | null; lastAttemptAt: string | null; lastSuccessAt: string | null; nextDueAt: string | null; status: 'not_configured' | 'success' | 'failed' | 'login_required'; lastError?: string }
}
export interface ComputeRecommendationInput {
  projectId?: number; requiredCapabilities: string[]; difficulty: ComputeDifficulty; dataClass: ComputeDataClass
  ready: boolean; valuable: boolean; reservePercent?: number; allowedBillingModes?: ComputeBillingMode[]
}
export type ComputeReasonCode = 'account_disabled' | 'binding_disabled' | 'billing_not_allowed' | 'identity_unverified' | 'entitlement_unverified'
  | 'access_refresh_required' | 'access_stale' | 'capability_mismatch' | 'model_unverified' | 'difficulty_mismatch' | 'data_scope_mismatch'
  | 'quota_not_configured' | 'quota_unknown' | 'quota_unavailable' | 'quota_refresh_required' | 'quota_stale' | 'quota_exhausted'
  | 'reset_unconfirmed' | 'reserve_protected' | 'task_not_ready' | 'task_not_valuable' | 'ready'
export interface ComputeCandidate {
  bindingId: string; accountId: string; runtimeId: string; modelId: string; executable: boolean; refreshRecommended: boolean
  effectiveRemainingPercent: number | null; reasonCodes: ComputeReasonCode[]; evidenceObservationIds: string[]; score: number
}
export interface ComputeRecommendation { asOf: string; reservePercent: number; candidates: ComputeCandidate[] }
