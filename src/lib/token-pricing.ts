import { getProviderFromModel } from '@/lib/provider-from-model'

interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
}

const DEFAULT_MODEL_PRICING: ModelPricing = {
  inputPerMTok: 3.0,
  outputPerMTok: 15.0,
}

// Base USD per million input/output tokens, verified 2026-09-08 for Claude and Grok:
// https://platform.claude.com/docs/en/about-claude/pricing
// https://docs.x.ai/developers/models/grok-4.6
// Model IDs: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
// Estimates exclude cache pricing, tool charges, fast/long-context/region premiums,
// batch discounts and tax. A subscription is not evidence of per-request billing.
// Older third-party estimates below were not reverified in this update.
const MODEL_PRICING: Record<string, ModelPricing> = {
  'anthropic/claude-3-5-haiku-latest': { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  'anthropic/claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },

  // Sonnet 5's $2/$10 price is permanent; the planned September increase was cancelled.
  'anthropic/claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
  'anthropic/claude-sonnet-4-20250514': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'anthropic/claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4-5': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'anthropic/claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  'claude-sonnet-4-6': { inputPerMTok: 3.0, outputPerMTok: 15.0 },

  'anthropic/claude-opus-4-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'anthropic/claude-opus-4-6': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-6': { inputPerMTok: 5.0, outputPerMTok: 25.0 },

  'anthropic/claude-fable-5-1': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'claude-fable-5-1': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'anthropic/claude-fable-5': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'claude-fable-5': { inputPerMTok: 10.0, outputPerMTok: 50.0 },
  'anthropic/claude-opus-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-5': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'anthropic/claude-opus-4-8': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-8': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'anthropic/claude-opus-4-7': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'claude-opus-4-7': { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  'anthropic/claude-opus-4-1': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'claude-opus-4-1': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'anthropic/claude-opus-4': { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  'claude-opus-4': { inputPerMTok: 15.0, outputPerMTok: 75.0 },

  'xai/grok-4.6': { inputPerMTok: 2.0, outputPerMTok: 6.0 },
  'grok-4.6': { inputPerMTok: 2.0, outputPerMTok: 6.0 },

  // For non-Anthropic models where we only have one published blended estimate,
  // apply the same rate for both input and output.
  'groq/llama-3.1-8b-instant': { inputPerMTok: 0.05, outputPerMTok: 0.05 },
  'groq/llama-3.3-70b-versatile': { inputPerMTok: 0.59, outputPerMTok: 0.59 },
  'moonshot/kimi-k2.5': { inputPerMTok: 1.0, outputPerMTok: 1.0 },
  'venice/llama-3.3-70b': { inputPerMTok: 0.7, outputPerMTok: 2.8 },
  'minimax/minimax-m2.1': { inputPerMTok: 0.3, outputPerMTok: 0.3 },
  // Local Ollama API fee only; excludes hardware and electricity costs.
  'ollama/qwen2.5:3b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'qwen2.5:3b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'ollama/deepseek-r1:14b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'ollama/qwen2.5-coder:7b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
  'ollama/qwen2.5-coder:14b': { inputPerMTok: 0.0, outputPerMTok: 0.0 },
}

function normalizedModelName(modelName: string): string {
  return modelName.trim().toLowerCase()
}

/** Exact catalogue matches only. Unknown models must not inherit a guessed tariff. */
export function getKnownModelPricing(modelName: string): ModelPricing | null {
  const normalized = normalizedModelName(modelName)
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, normalized)) return MODEL_PRICING[normalized]
  // Do not apply a local/first-party tariff to an unknown hosted provider.
  if (normalized.includes('/')) return null
  return Object.entries(MODEL_PRICING).find(([name]) => name.split('/').pop() === normalized)?.[1] || null
}

/**
 * True only when the catalogue actually knows this model.
 *
 * `getModelPricing` deliberately falls back to a Sonnet-shaped default so that a
 * cost is always produced. That fallback is a guess, not a price, and any caller
 * that reports coverage has to be able to tell the two apart. This delegates to
 * `getKnownModelPricing` so there is exactly one definition of "known".
 */
export function hasCatalogPrice(modelName: string): boolean {
  return getKnownModelPricing(modelName) !== null
}

/** Legacy estimate helper; cost reporting must use getKnownModelPricing. */
export function getModelPricing(modelName: string): ModelPricing {
  const normalized = normalizedModelName(modelName)
  if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, normalized)) return MODEL_PRICING[normalized]

  for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
    const shortName = model.split('/').pop() || model
    if (normalized.includes(shortName)) return pricing
  }

  return DEFAULT_MODEL_PRICING
}

interface CostOptions {
  providerSubscriptions?: Record<string, boolean>
}

export function calculateTokenCost(
  modelName: string,
  inputTokens: number,
  outputTokens: number,
  options?: CostOptions,
): number {
  const provider = getProviderFromModel(modelName)
  if (provider !== 'unknown' && options?.providerSubscriptions?.[provider]) {
    return 0
  }

  const pricing = getModelPricing(modelName)
  return ((inputTokens * pricing.inputPerMTok) + (outputTokens * pricing.outputPerMTok)) / 1_000_000
}
