import { describe, it, expect } from 'vitest'
import {
  COST_DISPLAY_MIN_COVERAGE,
  COST_SCOPE_NOTICE,
  COST_COVERAGE_TOOLTIP,
  COST_UNAVAILABLE_PLACEHOLDER,
  computePricedCoverage,
  resolveDisplayCoverage,
  isCostDisplayable,
  formatGatedCost,
} from '../cost-display'

const usd = (value: number) => '$' + value.toFixed(4)

describe('COST_DISPLAY_MIN_COVERAGE', () => {
  it('is the documented 50 % threshold and lives in lib, not in a component', () => {
    expect(COST_DISPLAY_MIN_COVERAGE).toBe(0.5)
  })
})

describe('COST_SCOPE_NOTICE', () => {
  it('names the actual data source and the population that is missing', () => {
    expect(COST_SCOPE_NOTICE).toBe(
      'Source: OpenClaw cron tokens. Native subscription workers (Claude/Codex) are not included.',
    )
  })
})

describe('computePricedCoverage', () => {
  it('returns null coverage when there are no tokens at all', () => {
    expect(computePricedCoverage([])).toEqual({ totalTokens: 0, pricedTokens: 0, coverage: null })
  })

  it('counts tokens of catalogue-priced models as priced', () => {
    const result = computePricedCoverage([
      { model: 'claude-sonnet-4-5', totalTokens: 100 },
      { model: 'claude-opus-4-6', totalTokens: 100 },
    ])
    expect(result).toEqual({ totalTokens: 200, pricedTokens: 200, coverage: 1 })
  })

  it('does not count tokens of models that only get the default fallback price', () => {
    const result = computePricedCoverage([
      { model: 'claude-sonnet-4-5', totalTokens: 100 },
      { model: 'some-unlisted-model', totalTokens: 300 },
    ])
    expect(result.totalTokens).toBe(400)
    expect(result.pricedTokens).toBe(100)
    expect(result.coverage).toBeCloseTo(0.25, 10)
  })

  it('reproduces the measured 2026-09-09 population as far below the threshold', () => {
    const result = computePricedCoverage([
      { model: 'claude-sonnet-4-5', totalTokens: 3_336 },
      { model: 'openclaw-unpriced-runtime', totalTokens: 2_410_000 - 3_336 },
    ])
    expect(result.coverage).toBeLessThan(COST_DISPLAY_MIN_COVERAGE)
    expect(isCostDisplayable(result.coverage)).toBe(false)
  })

  it('ignores negative and non-finite token counts instead of trusting them', () => {
    const result = computePricedCoverage([
      { model: 'claude-sonnet-4-5', totalTokens: 100 },
      { model: 'claude-sonnet-4-5', totalTokens: -50 },
      { model: 'claude-sonnet-4-5', totalTokens: Number.NaN },
    ])
    expect(result).toEqual({ totalTokens: 100, pricedTokens: 100, coverage: 1 })
  })
})

describe('isCostDisplayable', () => {
  it('is false when coverage is unknown', () => {
    expect(isCostDisplayable(null)).toBe(false)
    expect(isCostDisplayable(undefined)).toBe(false)
  })

  it('is false below the threshold and true at or above it', () => {
    expect(isCostDisplayable(0.4999)).toBe(false)
    expect(isCostDisplayable(COST_DISPLAY_MIN_COVERAGE)).toBe(true)
    expect(isCostDisplayable(0.9)).toBe(true)
  })
})

describe('formatGatedCost', () => {
  it('renders the placeholder, not a number, when coverage is below the threshold', () => {
    expect(formatGatedCost(0.00024, 0.0014, usd)).toBe(COST_UNAVAILABLE_PLACEHOLDER)
    expect(COST_UNAVAILABLE_PLACEHOLDER).toBe('—')
  })

  it('renders the placeholder when coverage is unknown', () => {
    expect(formatGatedCost(12.5, null, usd)).toBe(COST_UNAVAILABLE_PLACEHOLDER)
  })

  it('renders the formatted amount once coverage is good enough', () => {
    expect(formatGatedCost(12.5, 0.8, usd)).toBe('$12.5000')
  })

  it('gates a zero cost too — an unmeasured zero is not a measured zero', () => {
    expect(formatGatedCost(0, 0.1, usd)).toBe(COST_UNAVAILABLE_PLACEHOLDER)
    expect(formatGatedCost(0, 0.8, usd)).toBe('$0.0000')
  })
})

describe('COST_COVERAGE_TOOLTIP', () => {
  it('explains why the amount is hidden', () => {
    expect(COST_COVERAGE_TOOLTIP).toBe('Priced coverage below 50 %')
  })
})


describe('resolveDisplayCoverage', () => {
  const clientCoverage = computePricedCoverage([
    { model: 'claude-sonnet-4-5', totalTokens: 3_336 },
    { model: 'openclaw-cron-runtime', totalTokens: 2_406_664 },
  ])

  it('prefers the server measurement and converts its percent to a fraction', () => {
    // `/api/tokens` reports coverage.pricedTokenPercent on a 0-100 scale
    // (lib/token-ledger.ts), while the gate works in [0, 1].
    const resolved = resolveDisplayCoverage(90, clientCoverage)
    expect(resolved.source).toBe('server')
    expect(resolved.coverage).toBeCloseTo(0.9, 10)
    expect(isCostDisplayable(resolved.coverage)).toBe(true)
  })

  it('treats an explicit null from the server as a measured "no usage", not as absence', () => {
    // The server sets null when there were no tokens at all. That is an answer,
    // so it must not silently fall through to a client number computed from a
    // payload the server already declared empty.
    const resolved = resolveDisplayCoverage(null, clientCoverage)
    expect(resolved.source).toBe('server')
    expect(resolved.coverage).toBeNull()
    expect(isCostDisplayable(resolved.coverage)).toBe(false)
  })

  it('falls back to the client computation when the server field is absent', () => {
    const resolved = resolveDisplayCoverage(undefined, clientCoverage)
    expect(resolved.source).toBe('client')
    expect(resolved.coverage).toBe(clientCoverage.coverage)
  })

  it('falls back when the server field is not a usable number', () => {
    expect(resolveDisplayCoverage(Number.NaN, clientCoverage).source).toBe('client')
    expect(resolveDisplayCoverage(Number.POSITIVE_INFINITY, clientCoverage).source).toBe('client')
  })

  it('clamps a server percent outside 0-100 instead of producing an impossible share', () => {
    expect(resolveDisplayCoverage(140, clientCoverage).coverage).toBe(1)
    expect(resolveDisplayCoverage(-5, clientCoverage).coverage).toBe(0)
  })

  it('still gates when the server reports coverage below the threshold', () => {
    const resolved = resolveDisplayCoverage(0.14, clientCoverage)
    expect(resolved.coverage).toBeCloseTo(0.0014, 10)
    expect(formatGatedCost(0.00024, resolved.coverage, usd)).toBe(COST_UNAVAILABLE_PLACEHOLDER)
  })
})
