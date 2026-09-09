export interface CronOccurrence {
  atMs: number
  dayKey: string
}

interface ParsedField {
  any: boolean
  matches: (value: number) => boolean
}

interface ParsedCron {
  minute: ParsedField
  hour: ParsedField
  dayOfMonth: ParsedField
  month: ParsedField
  dayOfWeek: ParsedField
}

function normalizeCronExpression(raw: string): string {
  const trimmed = raw.trim()
  const tzSuffixMatch = trimmed.match(/^(.*)\s+\([^)]+\)$/)
  return (tzSuffixMatch?.[1] || trimmed).trim()
}

function parseToken(token: string, min: number, max: number): { any: boolean; values: Set<number> } {
  const valueSet = new Set<number>()
  const trimmed = token.trim()
  if (trimmed === '*') {
    for (let i = min; i <= max; i += 1) valueSet.add(i)
    return { any: true, values: valueSet }
  }

  for (const part of trimmed.split(',')) {
    const section = part.trim()
    if (!section) continue

    const [rangePart, stepPart] = section.split('/')
    const step = stepPart ? Number(stepPart) : 1
    if (!Number.isFinite(step) || step <= 0) continue

    if (rangePart === '*') {
      for (let i = min; i <= max; i += step) valueSet.add(i)
      continue
    }

    if (rangePart.includes('-')) {
      const [fromRaw, toRaw] = rangePart.split('-')
      const from = Number(fromRaw)
      const to = Number(toRaw)
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue
      const start = Math.max(min, Math.min(max, from))
      const end = Math.max(min, Math.min(max, to))
      for (let i = start; i <= end; i += step) valueSet.add(i)
      continue
    }

    const single = Number(rangePart)
    if (!Number.isFinite(single)) continue
    if (single >= min && single <= max) {
      if (stepPart) { for (let i = single; i <= max; i += step) valueSet.add(i) }
      else valueSet.add(single)
    }
  }

  return { any: false, values: valueSet }
}

function parseField(token: string, min: number, max: number): ParsedField {
  const parsed = parseToken(token, min, max)
  return {
    any: parsed.any,
    matches: (value: number) => parsed.values.has(value),
  }
}

function parseCron(raw: string): ParsedCron | null {
  const normalized = normalizeCronExpression(raw)
  const parts = normalized.split(/\s+/).filter(Boolean)
  if (parts.length !== 5) return null

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 7),
  }
}

function matchesDay(parsed: ParsedCron, day: number, weekday: number): boolean {
  const dayOfMonthMatches = parsed.dayOfMonth.matches(day)
  const dayOfWeekMatches = parsed.dayOfWeek.matches(weekday) || (weekday === 0 && parsed.dayOfWeek.matches(7))

  if (parsed.dayOfMonth.any && parsed.dayOfWeek.any) return true
  if (parsed.dayOfMonth.any) return dayOfWeekMatches
  if (parsed.dayOfWeek.any) return dayOfMonthMatches
  return dayOfMonthMatches || dayOfWeekMatches
}

export function buildDayKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const zonedMinutes = new Map<string, Date>()

export function getCronOccurrences(
  schedule: string,
  rangeStartMs: number,
  rangeEndMs: number,
  max = 1000
): CronOccurrence[] {
  if (!schedule || !Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs)) return []
  if (rangeEndMs <= rangeStartMs || max <= 0) return []

  const timezone = schedule.match(/\(([^)]+)\)\s*$/)?.[1]
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  let formatter: Intl.DateTimeFormat | undefined
  try {
    if (timezone && timezone !== localTimezone) formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
  } catch { return [] }

  const parsed = parseCron(schedule)
  if (!parsed) return []

  const occurrences: CronOccurrence[] = []
  const cursor = new Date(rangeStartMs)
  cursor.setSeconds(0, 0)
  if (cursor.getTime() < rangeStartMs) {
    cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
  }

  while (cursor.getTime() < rangeEndMs && occurrences.length < max) {
    let wallClock = cursor
    if (formatter) {
      const key = `${timezone}:${cursor.getTime()}`
      let cached = zonedMinutes.get(key)
      if (!cached) {
        const parts = Object.fromEntries(formatter.formatToParts(cursor).map(part => [part.type, part.value]))
        cached = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)))
        if (zonedMinutes.size >= 100000) zonedMinutes.clear()
        zonedMinutes.set(key, cached)
      }
      wallClock = cached
    }
    if (
      parsed.month.matches((formatter ? wallClock.getUTCMonth() : wallClock.getMonth()) + 1) &&
      matchesDay(parsed, formatter ? wallClock.getUTCDate() : wallClock.getDate(), formatter ? wallClock.getUTCDay() : wallClock.getDay()) &&
      parsed.hour.matches(formatter ? wallClock.getUTCHours() : wallClock.getHours()) &&
      parsed.minute.matches(formatter ? wallClock.getUTCMinutes() : wallClock.getMinutes())
    ) {
      occurrences.push({
        atMs: cursor.getTime(),
        dayKey: buildDayKey(cursor),
      })
    }
    cursor.setTime(cursor.getTime() + 60000)
  }

  return occurrences
}


/** Enabled schedules only; intervals use the gateway anchor and one-shots use their instant. */
export function getJobCalendarOccurrences(
  job: { schedule: string; enabled: boolean; nextRun?: number; everyMs?: number; anchorMs?: number },
  start: number, end: number, max = 1000,
): CronOccurrence[] {
  if (!job.enabled || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || max <= 0) return []
  if (job.schedule.startsWith('every ')) {
    const interval = job.everyMs
    const anchor = job.anchorMs ?? job.nextRun
    if (interval && interval > 0 && Number.isFinite(interval) && anchor != null && Number.isFinite(anchor)) {
      const rows: CronOccurrence[] = []
      let atMs = anchor + Math.max(0, Math.ceil((start - anchor) / interval)) * interval
      for (; atMs < end && rows.length < max; atMs += interval) rows.push({ atMs, dayKey: buildDayKey(new Date(atMs)) })
      return rows
    }
  }
  if (job.schedule.startsWith('at ')) {
    const atMs = Date.parse(job.schedule.slice(3))
    return atMs >= start && atMs < end ? [{ atMs, dayKey: buildDayKey(new Date(atMs)) }] : []
  }
  const occurrences = getCronOccurrences(job.schedule, start, end, max)
  if (occurrences.length === 0 && job.nextRun != null && job.nextRun >= start && job.nextRun < end) {
    occurrences.push({ atMs: job.nextRun, dayKey: buildDayKey(new Date(job.nextRun)) })
  }
  return occurrences
}
