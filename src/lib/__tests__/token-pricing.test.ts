import { describe, expect, it } from 'vitest'
import { calculateTokenCost, getModelPricing, getKnownModelPricing } from '@/lib/token-pricing'
import { getProviderFromModel } from '@/lib/provider-subscriptions'

describe('token pricing', () => {
  it('uses separate input/output rates for Claude Sonnet 4.5', () => {
    const cost = calculateTokenCost('anthropic/claude-sonnet-4-5', 10, 185)
    expect(cost).toBeCloseTo(0.002805, 9)
  })

  it('matches model aliases by short model name', () => {
    const pricing = getModelPricing('gateway::claude-opus-4-6')
    expect(pricing.inputPerMTok).toBe(5.0)
    expect(pricing.outputPerMTok).toBe(25.0)
  })

  it('falls back to conservative default pricing for unknown models', () => {
    const cost = calculateTokenCost('unknown/model', 1_000_000, 1_000_000)
    expect(cost).toBe(18)
  })

  it('keeps local models at zero cost', () => {
    const cost = calculateTokenCost('ollama/qwen2.5-coder:14b', 50_000, 50_000)
    expect(cost).toBe(0)
  })

  it('returns zero cost for subscribed providers', () => {
    const cost = calculateTokenCost('anthropic/claude-sonnet-4-5', 2000, 2000, {
      providerSubscriptions: { anthropic: true },
    })
    expect(cost).toBe(0)
  })

  it.each([
    ['claude-fable-5-1', 10, 50], ['claude-fable-5', 10, 50],
    ['claude-opus-5', 5, 25], ['claude-opus-4-8', 5, 25], ['claude-opus-4-7', 5, 25],
    ['claude-opus-4-6', 5, 25], ['claude-opus-4-5', 5, 25],
    ['claude-opus-4-1', 15, 75], ['claude-opus-4', 15, 75],
    ['claude-sonnet-5', 2, 10], ['claude-sonnet-4-6', 3, 15], ['claude-sonnet-4-5', 3, 15],
    ['claude-haiku-4-5', 1, 5], ['claude-3-5-haiku', 0.8, 4],
  ])('uses verified base rates for %s without blending model generations', (model, input, output) => {
    expect(getKnownModelPricing(model)).toEqual({ inputPerMTok: input, outputPerMTok: output })
    if (model !== 'claude-3-5-haiku') expect(getKnownModelPricing(`anthropic/${model}`)).toEqual(getKnownModelPricing(model))
  })

  it('keeps Grok input/output distinct and only local Qwen at zero API cost', () => {
    expect(getKnownModelPricing('grok-4.6')).toEqual({ inputPerMTok: 2, outputPerMTok: 6 })
    expect(getKnownModelPricing('xai/grok-4.6')).toEqual(getKnownModelPricing('grok-4.6'))
    expect(getKnownModelPricing('ollama/qwen2.5:3b')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
    expect(getKnownModelPricing('hosted/qwen2.5:3b')).toBeNull()
  })

  it('leaves unverified models and model variants unpriced in the reporting catalogue', () => {
    for (const model of ['__proto__', 'constructor', 'zai/glm-5.3', 'glm-5.3', 'claude-opus-4-6-fast', 'grok-4.6-new', 'unknown/claude-opus-4-6']) {
      expect(getKnownModelPricing(model)).toBeNull()
    }
  })

  it('maps providers from model prefixes and names', () => {
    expect(getProviderFromModel('openai/gpt-4.1')).toBe('openai')
    expect(getProviderFromModel('anthropic/claude-sonnet-4-5')).toBe('anthropic')
    expect(getProviderFromModel('venice/llama-3.3-70b')).toBe('venice')
    expect(getProviderFromModel('gateway::codex-mini')).toBe('openai')
  })
})
