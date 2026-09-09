export function getManagedReleasePolicy() {
  const managedRelease = process.env.MC_MANAGED_RELEASE === '1'
  return {
    managedRelease,
    managedUpdateReason: managedRelease
      ? 'Updates for this customized dashboard are tested and installed together.'
      : null,
  }
}
