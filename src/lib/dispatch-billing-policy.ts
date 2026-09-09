/** Subscription routes are executed by their verified harness, never the legacy gateway fallback. */
export function isManagedComputeTask(metadata: unknown): boolean {
  try {
    const value = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
    return !!value && typeof value === 'object' && 'compute_route' in value
  } catch { return false }
}

/** A configured API key is not authorization to spend outside an included subscription. */
export function allowsPaidApiFallback(metadata: unknown, enabled: string | undefined): boolean {
  if (enabled !== '1' || isManagedComputeTask(metadata)) return false
  try {
    const value = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
    return value?.workflow_contract?.resource_policy?.allow_paid_api_fallback === true
  } catch { return false }
}
