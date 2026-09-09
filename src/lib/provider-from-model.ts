/**
 * Map a model name to its provider.
 *
 * This lives in its own module because it is pure string work with no runtime
 * dependencies, while `provider-subscriptions.ts` imports `node:fs`,
 * `node:child_process` and `node:os` at module scope to detect installed CLIs.
 * `token-pricing.ts` needs only this function, and `token-pricing` is reachable
 * from client components through `cost-display.ts`. Importing it from
 * `provider-subscriptions` pulled `node:fs` into the browser bundle and broke
 * `next build` with "the chunking context does not support external modules".
 * Typecheck and jsdom tests cannot see that edge; only a production build can.
 *
 * `provider-subscriptions.ts` re-exports this symbol, so every existing import
 * path keeps working and the behaviour is unchanged.
 */
export function getProviderFromModel(modelName: string): string {
  const normalized = modelName.trim().toLowerCase()
  if (!normalized) return 'unknown'

  const [prefix] = normalized.split('/')
  if (prefix && !prefix.includes(':')) {
    // Most models are provider-prefixed, e.g., "anthropic/claude-sonnet-4-5".
    if (prefix === 'claude') return 'anthropic'
    if (prefix === 'gpt' || prefix === 'o1' || prefix === 'o3') return 'openai'
    return prefix
  }

  if (normalized.includes('claude')) return 'anthropic'
  if (normalized.includes('gpt') || normalized.includes('codex') || normalized.includes('o1') || normalized.includes('o3')) return 'openai'
  return 'unknown'
}
