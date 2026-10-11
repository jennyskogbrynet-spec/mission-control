#!/usr/bin/env node
/**
 * Mission Control factory hygiene CLI.
 *
 *   closure   open tasks whose linked PRs are all merged -> review (dry run by default)
 *   leases    claims idle past the lease -> Unclaimed        (dry run by default)
 *   intake    open tasks per intake source vs. the WIP caps; --promote brings deferred ones back
 *   measure   all three, read-only, one summary
 *
 * Everything goes through the MC HTTP API (auth, workspace scope, audit log, SSE all
 * stay server-side). GitHub is read with `gh api` here, never in the API route.
 *
 * Transport: MC_API_KEY (+ MC_URL, default http://127.0.0.1:3005) if set, otherwise the
 * local helper ~/.openclaw/workspace/skills/mission-control/scripts/mc-api.py, which
 * resolves the credential in-process. The credential is never printed.
 *
 * Nothing is written without --apply. --apply moves tasks to `review`, never `done`.
 */
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MC_API_PY = join(homedir(), '.openclaw', 'workspace', 'skills', 'mission-control', 'scripts', 'mc-api.py')

export function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      i += 1
    }
  }
  return { cmd, flags }
}

/** Map a `gh api repos/:owner/:repo/pulls/:n` document to the PrState MC expects. */
export function ghPullToState(doc, checkedAt = new Date().toISOString()) {
  const status = doc.merged === true || doc.merged_at ? 'merged' : doc.state === 'open' ? 'open' : doc.state === 'closed' ? 'closed' : 'error'
  return {
    status,
    merged_at: doc.merged_at ?? null,
    merge_commit_sha: doc.merge_commit_sha ?? null,
    base_ref: doc.base?.ref ?? null,
    title: typeof doc.title === 'string' ? doc.title.slice(0, 300) : null,
    checked_at: checkedAt,
  }
}

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Default GitHub reader: `gh api repos/<repo>/pulls/<n>` (REST, read-only). */
export function ghRead(repo, number) {
  return new Promise((resolve) => {
    execFile('gh', ['api', `repos/${repo}/pulls/${number}`], { timeout: 30_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) {
        const text = `${stderr || ''}${error.message || ''}`
        resolve({ ok: false, notFound: /HTTP 404|Not Found/i.test(text), detail: text.slice(0, 200) })
        return
      }
      try {
        resolve({ ok: true, doc: JSON.parse(stdout) })
      } catch {
        resolve({ ok: false, notFound: false, detail: 'unparseable gh output' })
      }
    })
  })
}

export async function lookupPrStates(keys, { read = ghRead, concurrency = 6, now = () => new Date().toISOString() } = {}) {
  const states = {}
  await mapWithConcurrency(keys, concurrency, async (key) => {
    const [repo, number] = key.split('#')
    let result = await read(repo, number)
    if (!result.ok && !result.notFound) result = await read(repo, number) // one retry for a transient failure
    if (result.ok) states[key] = ghPullToState(result.doc, now())
    else states[key] = { status: result.notFound ? 'not_found' : 'error', checked_at: now() }
  })
  return states
}

export function makeTransport(env = process.env) {
  if (env.MC_API_KEY) {
    const base = (env.MC_URL || 'http://127.0.0.1:3005').replace(/\/$/, '')
    return async (path, method = 'GET', body) => {
      const response = await fetch(base + path, {
        method,
        headers: { 'x-api-key': env.MC_API_KEY, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`Mission Control HTTP ${response.status}: ${text.slice(0, 500)}`)
      return JSON.parse(text)
    }
  }
  return async (path, method = 'GET', body) => {
    const args = ['-I', MC_API_PY, path, '--method', method]
    let dir = null
    try {
      if (body !== undefined) {
        dir = mkdtempSync(join(tmpdir(), 'mc-hygiene-'))
        writeFileSync(join(dir, 'body.json'), JSON.stringify(body))
        args.push('--data-file', join(dir, 'body.json'))
      }
      return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64_000_000 }))
    } catch (error) {
      throw new Error(String(error.stderr || error.message).trim().slice(0, 500))
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  }
}

const line = (log, text = '') => log(text)

function writeSnapshot(file, states, generatedAt) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ generated_at: generatedAt, source: 'gh api', prs: states }, null, 1))
  renameSync(tmp, file)
}

export async function runClosure(flags, { request, read = ghRead, log = console.log, now = () => new Date().toISOString() }) {
  const project = typeof flags.project === 'string' ? flags.project : null
  const apply = flags.apply === true
  const qs = new URLSearchParams({ limit: '500' })
  if (project) qs.set('project', project)

  const first = await request(`/api/tasks/closure-candidates?${qs}`)
  const keys = first.report.needs_lookup
  line(log, `project=${project ?? 'all'}  open tasks considered=${first.report.totals.considered}  PRs to look up=${keys.length}`)

  const states = flags['no-gh'] === true ? {} : await lookupPrStates(keys, { read, concurrency: Number(flags.concurrency) || 6, now })
  const counts = Object.values(states).reduce((acc, s) => ((acc[s.status] = (acc[s.status] ?? 0) + 1), acc), {})
  line(log, `GitHub: ${JSON.stringify(counts)}`)
  if (typeof flags['write-snapshot'] === 'string') {
    writeSnapshot(flags['write-snapshot'], states, now())
    line(log, `snapshot written: ${flags['write-snapshot']}`)
  }

  const body = { project, pr_states: states, apply: false, backfill_pr_numbers: flags.backfill === true, limit: 500 }
  const preview = await request('/api/tasks/closure-candidates', 'POST', body)
  const t = preview.report.totals
  line(log, `candidates=${t.candidate}  awaiting_review=${t.awaiting_review}  failed_but_shipped=${t.failed_but_shipped}  held=${t.held}  no_pr_refs=${t.no_pr_refs}`)
  for (const c of preview.report.candidates) {
    line(log, `  CANDIDATE #${c.task_id} [${c.status}] ${c.title.slice(0, 80)}  PRs: ${c.refs.map((r) => r.number).join(',')}${c.stale_claim ? '  (expired claim released too)' : ''}`)
  }
  if (preview.backfill) {
    line(log, `backfill github_pr_number: planned=${preview.backfill.planned} ambiguous=${preview.backfill.ambiguous} already_set=${preview.backfill.already_set}`)
  }
  if (!apply) {
    line(log, 'DRY RUN: nothing written. Re-run with --apply to move candidates to review.')
    return { exit: 0, preview }
  }
  const ids = typeof flags['task-ids'] === 'string' ? flags['task-ids'].split(',').map(Number).filter(Number.isInteger) : undefined
  const result = await request('/api/tasks/closure-candidates', 'POST', { ...body, apply: true, ...(ids ? { task_ids: ids } : {}) })
  line(log, `APPLIED: moved=${result.applied?.moved.length ?? 0} skipped=${result.applied?.skipped.length ?? 0}`)
  if (result.backfill?.written) line(log, `backfilled github_pr_number on ${result.backfill.written.updated.length} tasks`)
  return { exit: 0, preview, result }
}

export async function runLeases(flags, { request, log = console.log }) {
  const apply = flags.apply === true
  const body = { apply, ...(flags['lease-hours'] ? { lease_hours: Number(flags['lease-hours']) } : {}) }
  const result = await request('/api/tasks/claim-leases', 'POST', body)
  line(log, `lease=${result.lease_hours}h  held claims=${result.evaluated}  within lease=${result.within_lease}  protected=${result.protected.length}  expired=${result.expired.length}`)
  for (const e of result.expired) {
    line(log, `  EXPIRED #${e.task_id} [${e.status}] claimed_by=${String(e.claimed_by).slice(0, 40)} idle=${e.idle_hours}h last=${e.last_activity_source}`)
  }
  for (const e of result.protected) line(log, `  PROTECTED #${e.task_id} (${e.verdict}) idle=${e.idle_hours}h`)
  if (!apply) line(log, 'DRY RUN: nothing released. Re-run with --apply.')
  else line(log, `APPLIED: released=${result.released.length} skipped_changed=${result.skipped_changed.length}`)
  return { exit: 0, result }
}

export async function runIntake(flags, { request, log = console.log }) {
  const report = await request('/api/tasks/intake-wip')
  line(log, `rules: ${JSON.stringify(report.rules)}`)
  for (const r of report.rows) {
    line(log, `  ${String(r.project_slug).padEnd(12)} ${r.source.padEnd(24)} open=${String(r.open).padStart(3)} deferred=${r.deferred} cap=${r.cap ?? '-'} ${r.on_cap ?? ''}${r.at_or_over_cap ? '  AT/OVER CAP' : ''}`)
  }
  if (flags.promote !== true) return { exit: 0, report }
  const apply = flags.apply === true
  const result = await request('/api/tasks/intake-wip', 'POST', { apply })
  line(log, `${apply ? 'PROMOTED' : 'WOULD PROMOTE'}: ${apply ? result.result.promoted.length : result.plan.items.length} deferred tasks`)
  return { exit: 0, report, result }
}

export async function runMeasure(flags, deps) {
  const log = deps.log ?? console.log
  line(log, '== closure candidates ==')
  const closure = await runClosure({ ...flags, apply: false }, deps)
  line(log, '\n== claim leases ==')
  const leases = await runLeases({ ...flags, apply: false }, deps)
  line(log, '\n== intake per source ==')
  const intake = await runIntake({ ...flags, promote: false }, deps)
  return { exit: 0, closure, leases, intake }
}

const USAGE = `usage: mc-factory-hygiene.mjs <closure|leases|intake|measure> [flags]
  closure  [--project <slug>] [--backfill] [--apply] [--task-ids 1,2] [--write-snapshot <file>] [--no-gh] [--concurrency 6]
  leases   [--lease-hours 72] [--apply]
  intake   [--promote [--apply]]
  measure  [--project <slug>]        (read-only)`

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const { cmd, flags } = parseArgs(process.argv.slice(2))
  const runners = { closure: runClosure, leases: runLeases, intake: runIntake, measure: runMeasure }
  if (!runners[cmd]) {
    console.error(USAGE)
    process.exit(2)
  }
  runners[cmd](flags, { request: makeTransport() }).then(
    (r) => process.exit(r.exit),
    (error) => {
      console.error(`error: ${error.message}`)
      process.exit(1)
    },
  )
}
