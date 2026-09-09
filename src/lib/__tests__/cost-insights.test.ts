import { describe, expect, it } from 'vitest'
import { getLowestRecordedUnitCost, formatUsageCost, describeUsageCost, getKnownCostShare, formatPriceCoverage } from '../cost-insights'

describe('observed model cost', () => {
  it('does not promote empty or unknown models to a zero-cost winner', () => {
    expect(getLowestRecordedUnitCost({
      unknown: { totalTokens: 1000, totalCost: 0 },
      empty: { totalTokens: 0, totalCost: 0 },
      paid: { totalTokens: 1000, totalCost: 2 },
    })).toEqual({ model: 'paid', costPerToken: 0.002 })
  })
  it('does not treat subscription/free records as a comparable paid rate', () => {
    expect(getLowestRecordedUnitCost({ subscribed: { totalTokens: 100, totalCost: 0 } })).toBeNull()
  })
  it('compares recorded unit cost rather than total spend', () => {
    expect(getLowestRecordedUnitCost({ a: { totalTokens: 100, totalCost: 1 }, b: { totalTokens: 1000, totalCost: 5 } })?.model).toBe('b')
  })
  it('rejects negative and non-finite observations', () => {
    expect(getLowestRecordedUnitCost({ a: { totalTokens: Infinity, totalCost: 1 }, b: { totalTokens: 1000, totalCost: -1 } })).toBeNull()
  })
})


it('keeps small costs visible in the dashboard', () => {
  expect(formatUsageCost(0.000004)).toBe('$0.00000400')
  expect(formatUsageCost(0)).toBe('$0.0000')
  expect(formatUsageCost(Number.NaN)).toBe('Unknown')
})

describe('price coverage in visible cost rows', () => {
  it('distinguishes unknown GLM/Sol usage from explicitly priced local zero', () => {
    expect(describeUsageCost({ totalTokens: 1700000, totalCost: 0, pricedTokens: 0, pricedRecordCount: 0 })).toMatchObject({ label: 'Unknown', costPerThousand: null, hasKnownCost: false })
    expect(describeUsageCost({ totalTokens: 1000, totalCost: 0, pricedTokens: 1000, pricedRecordCount: 1 })).toMatchObject({ label: '$0.0000', costPerThousand: 0, hasKnownCost: true })
  })
  it('does not dilute a known rate with unpriced tokens and labels partial totals', () => {
    const info = describeUsageCost({ totalTokens: 1700000, totalCost: 0.000014, pricedTokens: 4, pricedRecordCount: 1 })
    expect(info.label).toBe('$0.0000140 (partial)')
    expect(info.costPerThousand).toBeCloseTo(0.0035)
    expect(describeUsageCost({ totalTokens: 1700000, totalCost: 0.000014, requestCount: 1000, pricedTokens: 4, pricedRecordCount: 1 }).costPerRecord).toBe(0.000014)
    expect(getLowestRecordedUnitCost({ mixed: { totalTokens: 10006, totalCost: 6, pricedTokens: 6, pricedRecordCount: 1 }, other: { totalTokens: 8, totalCost: 4, pricedTokens: 8, pricedRecordCount: 1 } })?.model).toBe('other')
  })
  it('uses an exact positive denominator for tiny known costs and separates zero totals', () => {
    expect(getKnownCostShare(0.000014, 0.000014)).toBe(100)
    expect(getKnownCostShare(0.0000035, 0.000014)).toBe(25)
    expect(getKnownCostShare(0, 0.000014)).toBe(0)
    expect(getKnownCostShare(0, 0)).toBeNull()
    expect(formatPriceCoverage(4 / 1700000 * 100)).toBe('<0.1%')
    expect(formatPriceCoverage(0)).toBe('0.0%')
  })
})
