import { describe, expect, it } from 'vitest'
import { allowsPaidApiFallback, isManagedComputeTask } from '../dispatch-billing-policy'

describe('subscription dispatch boundary', () => {
  it('requires both operator configuration and explicit task billing policy', () => {
    const consent = { workflow_contract: { resource_policy: { allow_paid_api_fallback: true } } }
    expect(allowsPaidApiFallback(consent, '1')).toBe(true)
    expect(allowsPaidApiFallback(consent, undefined)).toBe(false)
    expect(allowsPaidApiFallback({}, '1')).toBe(false)
    expect(allowsPaidApiFallback('{broken', '1')).toBe(false)
  })
  it('keeps account-bound tasks out of legacy dispatch even with malformed route values', () => {
    for (const route of [null, {}, { bindingId: 3 }]) {
      const metadata = JSON.stringify({ compute_route: route, workflow_contract: { resource_policy: { allow_paid_api_fallback: true } } })
      expect(isManagedComputeTask(metadata)).toBe(true)
      expect(allowsPaidApiFallback(metadata, '1')).toBe(false)
    }
    expect(isManagedComputeTask(null)).toBe(false)
  })
})
