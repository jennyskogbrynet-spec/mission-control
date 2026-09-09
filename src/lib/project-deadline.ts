/** Whole Unix seconds within calendar years 0001–9999, or an explicit clear. */
export function isValidProjectDeadline(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value)
    && value >= -62135596800 && value <= 253402300799)
}
