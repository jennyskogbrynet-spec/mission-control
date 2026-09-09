export function describeCronFrequency(schedule: string): string {
  const parts = schedule.replace(/\s*\([^)]+\)$/, '').trim().split(/\s+/)
  if (parts.length !== 5) return schedule

  const [minute, hour, dom, mon, dow] = parts

  // Every minute
  if (minute === '*' && hour === '*') return 'every minute'
  // Every N minutes
  if (minute.startsWith('*/') && hour === '*') return `every ${minute.slice(2)}m`
  // Every hour at :MM
  if (/^\d+$/.test(minute) && hour === '*') return `hourly at :${minute.padStart(2, '0')}`
  // Every N hours
  if (/^\d+$/.test(minute) && hour.startsWith('*/')) return `every ${hour.slice(2)}h`
  // Specific hour(s) daily
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    const h = Number(hour)
    const m = Number(minute)
    const time = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
    if (dow !== '*') return `${time} (select days)`
    return `daily at ${time}`
  }
  // Weekly
  if (dom === '*' && mon === '*' && dow !== '*') return 'weekly'
  // Monthly
  if (dom !== '*' && mon === '*' && dow === '*') return 'monthly'

  return schedule
}

export function validateCronExpression(expr: string): string | null {
  if (!expr || !expr.trim()) return 'Cron expression is required'

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return `Expected 5 fields, got ${parts.length}`

  const fieldNames = ['minute', 'hour', 'day of month', 'month', 'day of week']
  const maxValues = [59, 23, 31, 12, 7]
  const minValues = [0, 0, 1, 1, 0]

  const isUnsignedInteger = (value: string) => /^\d+$/.test(value)

  for (let i = 0; i < 5; i++) {
    const field = parts[i]
    if (field === '*') continue

    const name = fieldNames[i]
    const min = minValues[i]
    const max = maxValues[i]

    // Comma-separated values, ranges, and steps (e.g. 5, 9-17, */2, 9-17/2)
    const segments = field.split(',')
    for (const segment of segments) {
      if (segment === '') return `Empty value in ${name}: ${field}`

      // Split off an optional /step suffix (e.g. */2, 9-17/2).
      const slashIndex = segment.indexOf('/')
      const base = slashIndex === -1 ? segment : segment.slice(0, slashIndex)
      const step = slashIndex === -1 ? null : segment.slice(slashIndex + 1)

      if (step !== null) {
        if (!isUnsignedInteger(step) || !Number.isSafeInteger(Number(step)) || Number(step) < 1) {
          return `Invalid step value in ${name}: ${segment}`
        }
      }

      if (base === '*') {
        // '*' is only valid as a whole field (handled above) or as */N.
        if (step === null) return `Invalid value in ${name}: ${segment}`
        continue
      }

      let start: number
      let end: number
      if (base.includes('-')) {
        // Range: N-M (exactly one dash, both endpoints unsigned integers)
        const rangeParts = base.split('-')
        if (
          rangeParts.length !== 2 ||
          !isUnsignedInteger(rangeParts[0]) ||
          !isUnsignedInteger(rangeParts[1])
        ) {
          return `Invalid range in ${name}: ${segment}`
        }
        start = Number(rangeParts[0])
        end = Number(rangeParts[1])
      } else {
        if (!isUnsignedInteger(base)) return `Invalid value in ${name}: ${segment}`
        start = end = Number(base)
      }

      if (start < min || start > max) return `${name} value ${start} out of range (${min}-${max})`
      if (end < min || end > max) return `${name} value ${end} out of range (${min}-${max})`
      if (end < start) return `Invalid range in ${name}: ${segment} (start exceeds end)`
    }
  }

  return null
}

export function generateCloneName(name: string, existingNames: string[]): string {
  const existing = new Set(existingNames.map(n => n.toLowerCase()))
  let cloneName = `${name} (copy)`
  let counter = 2
  while (existing.has(cloneName.toLowerCase())) {
    cloneName = `${name} (copy ${counter})`
    counter++
  }
  return cloneName
}
