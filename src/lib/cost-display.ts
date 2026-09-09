import { hasCatalogPrice } from '@/lib/token-pricing'

/**
 * Honest presentation rules for the cost surfaces.
 *
 * Two separate problems are handled here, and they stay separate on purpose:
 *
 * 1. SCOPE. The token ledger behind every cost tab is fed by OpenClaw cron runs.
 *    The native subscription workers (Claude Code, Codex) do the bulk of the
 *    actual work and report nothing into it. A dollar figure computed from that
 *    ledger describes one slice of the fleet, never the fleet. The label says so
 *    on every tab instead of leaving the reader to assume it is total spend.
 *
 * 2. COVERAGE. `getModelPricing` falls back to a default rate for any model the
 *    catalogue does not list, so a cost is always produced even when no price is
 *    known. Measured 2026-09-09: 2.41 M tokens for the week, 3 336 of them
 *    catalogue-priced — 0.14 %. Rendering "$0.0002" off that is fabricated
 *    precision. Below the threshold the amount is withheld instead.
 *
 * Neither rule invents a better number; both refuse to present a bad one as good.
 */

/** Minimum share of catalogue-priced tokens before a dollar amount may be shown. */
export const COST_DISPLAY_MIN_COVERAGE = 0.5

/** Scope label rendered on every cost tab. */
export const COST_SCOPE_NOTICE =
  'Source: OpenClaw cron tokens. Native subscription workers (Claude/Codex) are not included.'

/** Tooltip explaining a withheld amount. */
export const COST_COVERAGE_TOOLTIP = 'Priced coverage below 50 %'

/** Rendered in place of a dollar amount that cannot be shown honestly. */
export const COST_UNAVAILABLE_PLACEHOLDER = '—'

export interface ModelTokenTotal {
  model: string
  totalTokens: number
}

export interface PricedCoverage {
  totalTokens: number
  pricedTokens: number
  /** Priced share in [0, 1], or `null` when there is nothing to divide by. */
  coverage: number | null
}

function safeTokenCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return value
}

/**
 * Split a per-model token breakdown into catalogue-priced and unpriced tokens.
 *
 * `coverage` is `null` — not `0` — when there are no tokens at all, because
 * "nothing happened" and "nothing was priced" are different statements. The
 * display gate refuses both, for different reasons.
 */
export function computePricedCoverage(entries: readonly ModelTokenTotal[]): PricedCoverage {
  let totalTokens = 0
  let pricedTokens = 0

  for (const entry of entries) {
    const tokens = safeTokenCount(entry?.totalTokens)
    if (tokens === 0) continue
    totalTokens += tokens
    if (hasCatalogPrice(entry.model ?? '')) pricedTokens += tokens
  }

  return {
    totalTokens,
    pricedTokens,
    coverage: totalTokens > 0 ? pricedTokens / totalTokens : null,
  }
}

/**
 * Coverage to gate on, preferring the server's own measurement.
 *
 * `/api/tokens` reports `coverage.pricedTokenPercent` (see `lib/token-ledger.ts`)
 * over the same ledger this panel renders, but with the fuller view of which
 * records carry a known price — reported costs, excluded duplicates and
 * snapshot overlaps included. The client-side `computePricedCoverage` only sees
 * the per-model token breakdown, so it is the weaker of the two and stays as the
 * fallback for payloads that carry no coverage envelope.
 *
 * The two scales differ: the server reports a percentage (0-100), the gate works
 * in [0, 1]. An explicit `null` from the server is an answer ("no tokens in this
 * timeframe"), not an absence, and is passed straight through so the display
 * withholds for the server's stated reason rather than a recomputed one.
 */
export function resolveDisplayCoverage(
  serverPricedTokenPercent: number | null | undefined,
  clientCoverage: PricedCoverage,
): { coverage: number | null; source: 'server' | 'client' } {
  if (serverPricedTokenPercent === null) return { coverage: null, source: 'server' }
  if (typeof serverPricedTokenPercent === 'number' && Number.isFinite(serverPricedTokenPercent)) {
    const clamped = Math.min(100, Math.max(0, serverPricedTokenPercent))
    return { coverage: clamped / 100, source: 'server' }
  }
  return { coverage: clientCoverage.coverage, source: 'client' }
}

/** Whether a dollar amount may be rendered at this coverage. Unknown means no. */
export function isCostDisplayable(coverage: number | null | undefined): boolean {
  if (typeof coverage !== 'number' || !Number.isFinite(coverage)) return false
  return coverage >= COST_DISPLAY_MIN_COVERAGE
}

/**
 * Format a cost, or withhold it when coverage does not support it.
 *
 * A zero cost is gated exactly like any other amount: at 0.14 % coverage a "$0"
 * reads as a measured zero spend, which is the specific confusion this module
 * exists to prevent.
 */
export function formatGatedCost(
  cost: number,
  coverage: number | null | undefined,
  format: (value: number) => string,
): string {
  if (!isCostDisplayable(coverage)) return COST_UNAVAILABLE_PLACEHOLDER
  return format(cost)
}
