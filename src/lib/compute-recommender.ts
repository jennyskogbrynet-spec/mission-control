import type { ComputeCandidate, ComputeOverview, ComputeRecommendation, ComputeRecommendationInput, ComputeReasonCode } from './compute-types'

/** Pure preview: never dispatches, changes accounts, redeems credits, or retries a model call. */
export function recommendCompute(overview: ComputeOverview, input: ComputeRecommendationInput): ComputeRecommendation {
  const now = Date.parse(overview.asOf)
  const reservePercent = input.reservePercent ?? 20
  const allowedBillingModes = input.allowedBillingModes ?? ['subscription', 'local']
  const candidates: ComputeCandidate[] = []
  for (const binding of overview.bindings) {
    const account = overview.accounts.find(item => item.id === binding.accountId)
    if (!account) continue
    for (const modelId of binding.modelIds) {
      const reasons = new Set<ComputeReasonCode>()
      const evidence = new Set<string>()
      if (binding.observationId) evidence.add(binding.observationId)
      const model = binding.modelCapabilities.find(item => item.modelId === modelId)
      if (!account.enabled) reasons.add('account_disabled')
      if (!binding.enabled) reasons.add('binding_disabled')
      if (account.billingMode === 'unknown' || !allowedBillingModes.includes(account.billingMode)) reasons.add('billing_not_allowed')
      if (binding.identityStatus !== 'verified' || account.status === 'login_required' || account.status === 'unavailable') reasons.add('identity_unverified')
      if (binding.entitlementStatus !== 'verified') reasons.add('entitlement_unverified')
      if (binding.verificationFreshness === 'stale') reasons.add('access_stale')
      else if (binding.verificationFreshness !== 'fresh') reasons.add('access_refresh_required')
      if (!model?.verifiedAt || !model.evidence.trim()) reasons.add('model_unverified')
      if (input.requiredCapabilities.some(capability => !binding.capabilities.includes(capability) || !model?.capabilities.includes(capability))) reasons.add('capability_mismatch')
      if ((input.difficulty === 'complex' && model?.tier !== 'deep') || (input.difficulty === 'standard' && model?.tier === 'fast')) reasons.add('difficulty_mismatch')
      if (!binding.dataClasses.includes(input.dataClass) || (input.dataClass === 'restricted' && account.billingMode !== 'local')) reasons.add('data_scope_mismatch')
      if (!input.ready) reasons.add('task_not_ready')
      if (!input.valuable) reasons.add('task_not_valuable')
      const pools = account.pools.filter(pool => binding.poolIds.includes(pool.id) && (!pool.modelIds.length || pool.modelIds.includes(modelId)))
      if (account.billingMode !== 'local' && !pools.length) reasons.add('quota_not_configured')
      for (const pool of pools) {
        if (pool.observationId) evidence.add(pool.observationId)
        const code: Partial<Record<typeof pool.status, ComputeReasonCode>> = {
          unknown: 'quota_unknown', unavailable: 'quota_unavailable', refresh_required: 'quota_refresh_required', stale: 'quota_stale', exhausted: 'quota_exhausted', reset_unconfirmed: 'reset_unconfirmed',
        }
        if (code[pool.status]) reasons.add(code[pool.status]!)
      }
      const remaining = pools.length && pools.every(pool => pool.effectiveRemainingPercent !== null) ? Math.min(...pools.map(pool => pool.effectiveRemainingPercent!)) : null
      if (remaining !== null && remaining <= reservePercent) reasons.add('reserve_protected')
      const executable = reasons.size === 0
      const refreshRecommended = ['access_refresh_required', 'access_stale', 'quota_refresh_required', 'quota_stale', 'quota_unavailable', 'reset_unconfirmed'].some(code => reasons.has(code as ComputeReasonCode))
      const preferredTier = input.difficulty === 'complex' ? 'deep' : input.difficulty === 'standard' ? 'balanced' : 'fast'
      let score = executable ? 100 + (model?.tier === preferredTier ? 20 : 10) + (remaining == null ? 0 : Math.max(0, remaining - reservePercent) / 10) : 0
      // A small tie-breaker for useful work only. Never spend just to exhaust a quota.
      if (executable && input.ready && input.valuable) {
        const resets = pools.flatMap(pool => pool.windows.flatMap(window => window.resetsAt ? [Date.parse(window.resetsAt)] : [])).filter(reset => reset > now)
        const nextReset = resets.length ? Math.min(...resets) : Infinity
        if (nextReset - now <= 6 * 60 * 60_000) score += 2 * (1 - (nextReset - now) / (6 * 60 * 60_000))
      }
      candidates.push({ bindingId: binding.id, accountId: account.id, runtimeId: binding.runtimeId, modelId, executable, refreshRecommended,
        effectiveRemainingPercent: remaining, reasonCodes: executable ? ['ready'] : [...reasons], evidenceObservationIds: [...evidence], score: Math.round(score * 100) / 100 })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.bindingId.localeCompare(b.bindingId) || a.modelId.localeCompare(b.modelId))
  return { asOf: overview.asOf, reservePercent, candidates }
}
