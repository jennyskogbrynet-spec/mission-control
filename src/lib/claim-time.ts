export const ACTIVE_CLAIM_REJECT_DEFER_MS = 15 * 60 * 1000

export function parseClaimedAtMs(value: unknown): number | null {
  if (value === null || value === undefined) return null

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000
    }

    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

export function getClaimAgeMs(claimedAt: unknown, nowMs = Date.now()): number | null {
  const claimedAtMs = parseClaimedAtMs(claimedAt)
  if (claimedAtMs === null) return null
  return Math.max(0, nowMs - claimedAtMs)
}

export function isActiveClaim(
  claimState: unknown,
  claimedAt: unknown,
  maxAgeMs = ACTIVE_CLAIM_REJECT_DEFER_MS,
  nowMs = Date.now(),
): { active: boolean; claimAgeMs: number | null } {
  const claimAgeMs = getClaimAgeMs(claimedAt, nowMs)
  return {
    active: claimState === 'Claimed' && claimAgeMs !== null && claimAgeMs < maxAgeMs,
    claimAgeMs,
  }
}
