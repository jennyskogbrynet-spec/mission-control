export interface CostCoverage { pricedTokens?: number; pricedRecordCount?: number }
interface ModelCost extends CostCoverage { totalTokens: number; totalCost: number; requestCount?: number }

/** Preserve unknown versus measured/estimated zero and divide only by priced tokens. */
export function describeUsageCost(stats: ModelCost) {
  const hasKnownCost = Number.isFinite(stats.totalCost) && stats.totalCost >= 0 &&
    (stats.pricedRecordCount == null ? stats.totalCost > 0 : stats.pricedRecordCount > 0)
  const pricedTokens = stats.pricedTokens ?? (hasKnownCost ? stats.totalTokens : 0)
  const pricedRecordCount = stats.pricedRecordCount ?? (hasKnownCost ? stats.requestCount : 0)
  const partial = hasKnownCost && (pricedTokens < stats.totalTokens || (pricedRecordCount != null && stats.requestCount != null && pricedRecordCount < stats.requestCount))
  const costPerThousand = hasKnownCost && Number.isFinite(pricedTokens) && pricedTokens > 0
    ? stats.totalCost / pricedTokens * 1000 : null
  const costPerRecord = hasKnownCost && pricedRecordCount != null && pricedRecordCount > 0 ? stats.totalCost / pricedRecordCount : null
  return { hasKnownCost, partial, costPerThousand, costPerRecord,
    label: hasKnownCost ? `${formatUsageCost(stats.totalCost)}${partial ? ' (partial)' : ''}` : 'Unknown' }
}

/** Percentage of a known positive amount; never impose a dollar floor. */
export function getKnownCostShare(cost: number, total: number): number | null {
  return Number.isFinite(cost) && cost >= 0 && Number.isFinite(total) && total > 0 ? cost / total * 100 : null
}

export function formatPriceCoverage(percent: number | null): string {
  if (percent == null || !Number.isFinite(percent)) return 'no usage'
  return percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`
}

/** An observation, not a model-quality ranking or savings recommendation. */
export function getLowestRecordedUnitCost(models: Record<string, ModelCost>) {
  const eligible = Object.entries(models).map(([model, stats]) => ({ model, costPerThousand: describeUsageCost(stats).costPerThousand })).filter(entry =>
    !!entry.model.trim() && !['unknown', 'default', 'none'].includes(entry.model.trim().toLowerCase()) &&
    entry.costPerThousand != null && entry.costPerThousand > 0,
  )
  if (eligible.length === 0) return null
  const lowest = eligible.reduce((a, b) => b.costPerThousand! < a.costPerThousand! ? b : a)
  return { model: lowest.model, costPerToken: lowest.costPerThousand! / 1000 }
}


/** Keep small observed costs visible rather than rounding them to zero. */
export function formatUsageCost(cost: number): string {
  if (!Number.isFinite(cost)) return 'Unknown'
  return '$' + (cost !== 0 && Math.abs(cost) < 0.0001 ? cost.toPrecision(3) : cost.toFixed(4))
}
