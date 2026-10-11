/**
 * Pull-request references on a task row.
 *
 * Mission Control has a `github_pr_number` column that nothing fills in, while
 * the factory records PR links inside `metadata` in many shapes (`prUrl`,
 * `native_codex_review.candidate.prNumber`, `product_delivery.prNumber`,
 * `feature_audit_fix.pr`, ...). This module reads both places and returns one
 * deduplicated list. It is pure: no I/O, no database.
 *
 * Only keys whose NAME says "pull request" are read. A bare number under an
 * unrelated key is never taken for a PR, and free text is never searched.
 */

export interface PrRef {
  /** `owner/repo`, lower-cased, or null when the value was a bare number. */
  repo: string | null
  number: number
  /** Where the reference was found: `column` or a dotted metadata path. */
  sources: string[]
}

const MAX_DEPTH = 8
const MAX_NODES = 5000
const MAX_ARRAY = 200

const PR_URL = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,7})(?:[/?#].*)?$/i
const REPO_HASH = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,7})$/
const BARE_NUMBER = /^#?(\d{1,7})$/

/** `featurePrNumber` -> [feature, pr, number]; `pr_url` -> [pr, url]. */
function tokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const TAIL = new Set(['number', 'num', 'url', 'id', 'link'])

/** True when the key names ONE pull request (`pr`, `prNumber`, `github_pr_url`, `followupPullRequest`, ...). */
export function isPrKey(key: string): boolean {
  const t = tokens(key)
  const n = t.length
  if (n === 0) return false
  const last = t[n - 1]
  const prev = n > 1 ? t[n - 2] : ''
  if (last === 'pr') return true
  if (TAIL.has(last) && prev === 'pr') return true
  if (last === 'request' && prev === 'pull') return true
  if (TAIL.has(last) && prev === 'request' && n > 2 && t[n - 3] === 'pull') return true
  return false
}

/** True when the key names a LIST of pull requests (`prs`, `pull_requests`). */
export function isPrListKey(key: string): boolean {
  const t = tokens(key)
  const n = t.length
  if (n === 0) return false
  const last = t[n - 1]
  if (last === 'prs') return true
  return last === 'requests' && n > 1 && t[n - 2] === 'pull'
}

/** Parse one scalar into a (repo, number) pair, or null when it is not a PR reference. */
export function parsePrValue(value: unknown): { repo: string | null; number: number } | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value < 10_000_000 ? { repo: null, number: value } : null
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > 400) return null
  const url = PR_URL.exec(text)
  if (url) return { repo: `${url[1]}/${url[2]}`.toLowerCase(), number: Number(url[3]) }
  const hash = REPO_HASH.exec(text)
  if (hash) return { repo: `${hash[1]}/${hash[2]}`.toLowerCase(), number: Number(hash[3]) }
  const bare = BARE_NUMBER.exec(text)
  if (bare) {
    const n = Number(bare[1])
    return n > 0 ? { repo: null, number: n } : null
  }
  return null
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === '') return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(raw))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Collect every PR reference on a task.
 *
 * `defaultRepo` resolves bare numbers; without it they stay `repo: null` so the
 * caller can refuse to guess. Results are deduplicated on (repo, number); a bare
 * number that matches a URL-qualified reference of the same number is merged
 * into it.
 */
export function extractPrRefs(
  task: { github_pr_number?: number | null; github_repo?: string | null; metadata?: unknown },
  defaultRepo: string | null = null,
): PrRef[] {
  const found: Array<{ repo: string | null; number: number; source: string }> = []

  const column = task.github_pr_number
  if (typeof column === 'number' && Number.isInteger(column) && column > 0) {
    const repo = typeof task.github_repo === 'string' && task.github_repo.includes('/') ? task.github_repo.toLowerCase() : null
    found.push({ repo, number: column, source: 'column' })
  }

  let nodes = 0
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH || nodes++ > MAX_NODES) return
    if (Array.isArray(node)) {
      for (const item of node.slice(0, MAX_ARRAY)) walk(item, `${path}[]`, depth + 1)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key
      if (isPrKey(key) && (typeof value === 'string' || typeof value === 'number')) {
        const parsed = parsePrValue(value)
        if (parsed) found.push({ ...parsed, source: here })
      } else if (isPrListKey(key) && Array.isArray(value)) {
        for (const item of value.slice(0, MAX_ARRAY)) {
          const parsed = parsePrValue(item)
          if (parsed) found.push({ ...parsed, source: `${here}[]` })
        }
      } else if (value && typeof value === 'object') {
        walk(value, here, depth + 1)
      }
    }
  }
  walk(parseMetadata(task.metadata), '', 0)

  // A bare number takes the repo of a URL-qualified reference to the same number,
  // otherwise the supplied default.
  const repoByNumber = new Map<number, string>()
  for (const f of found) if (f.repo && !repoByNumber.has(f.number)) repoByNumber.set(f.number, f.repo)

  const merged = new Map<string, PrRef>()
  for (const f of found) {
    const repo = f.repo ?? repoByNumber.get(f.number) ?? (defaultRepo ? defaultRepo.toLowerCase() : null)
    const key = `${repo ?? '?'}#${f.number}`
    const existing = merged.get(key)
    if (existing) {
      if (!existing.sources.includes(f.source)) existing.sources.push(f.source)
    } else {
      merged.set(key, { repo, number: f.number, sources: [f.source] })
    }
  }
  return [...merged.values()].sort((a, b) => a.number - b.number)
}

/** Stable map key for a PR: `owner/repo#123`. */
export function prKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}
