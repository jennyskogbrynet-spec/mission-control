// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * `scripts/evidence-retention.py` proposes; it never acts. These tests pin both
 * halves: that a journal-proven closed bundle ages into an archive proposal, and
 * that nothing the journal cannot speak for is ever proposed for anything.
 */
const SCRIPT = path.join(process.cwd(), 'scripts', 'evidence-retention.py')
const DAY = 86_400

let root = ''
let evidence = ''
let runs = ''
const NOW = 1_800_000_000

function bundle(name: string, ageDays: number, files: Record<string, unknown> = {}) {
  const dir = path.join(evidence, name)
  mkdirSync(dir, { recursive: true })
  const entries = Object.keys(files).length ? files : { 'native-terminal.json': { status: 'completed' } }
  for (const [file, body] of Object.entries(entries)) {
    writeFileSync(path.join(dir, file), JSON.stringify(body))
  }
  const at = NOW - ageDays * DAY
  for (const file of Object.keys(entries)) utimesSync(path.join(dir, file), at, at)
  utimesSync(dir, at, at)
  return dir
}

function journal(name: string, workers: Array<Record<string, unknown>>) {
  writeFileSync(path.join(runs, `${name}.json`), JSON.stringify({ id: name, projectId: 2, workers }))
}

function worker(bundleName: string, status: string, file = 'native-terminal.json') {
  return {
    workerId: `w-${bundleName}-${status}`,
    taskId: 999,
    status,
    sessionRef: 'claude-code:sess-one',
    receiptRef: path.join(evidence, bundleName, file),
  }
}

function run(extra: string[] = []) {
  return JSON.parse(
    execFileSync(
      'python3',
      [SCRIPT, '--root', evidence, '--journal-root', runs, '--json', '--now', String(NOW), ...extra],
      { encoding: 'utf8' },
    ),
  )
}

function bucketOf(report: ReturnType<typeof run>, name: string) {
  return report.bundles.find((b: { name: string }) => b.name === name)?.bucket
}

describe('scripts/evidence-retention.py', () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'mc-retention-'))
    evidence = path.join(root, 'evidence')
    runs = path.join(root, 'runs')
    mkdirSync(evidence)
    mkdirSync(runs)
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('proposes an archive for a closed bundle past the archive age, with a hash manifest first', () => {
    bundle('closed-old', 30)
    journal('run-1', [worker('closed-old', 'completed')])

    const report = run()

    expect(report.mutating).toBe(false)
    const entry = report.bundles.find((b: { name: string }) => b.name === 'closed-old')
    expect(entry.state).toBe('closed')
    expect(entry.bucket).toBe('archive_proposed')
    expect(entry.proposed_commands[0]).toContain('shasum -a 256')
    expect(entry.proposed_commands.some((c: string) => c.includes('tar --zstd -cf'))).toBe(true)
    // Removal is never a command the tool would run itself.
    expect(entry.proposed_commands.at(-1)).toMatch(/^# then, and only with Martin/)
    expect(report.totals.archive_proposed).toBe(1)
  })

  it('retains a closed bundle that is still young', () => {
    bundle('closed-young', 3)
    journal('run-1', [worker('closed-young', 'completed')])
    expect(bucketOf(run(), 'closed-young')).toBe('retain')
  })

  it('flags a very old closed bundle for Martin instead of proposing an archive', () => {
    bundle('closed-ancient', 200)
    journal('run-1', [worker('closed-ancient', 'completed')])

    const report = run()
    const entry = report.bundles.find((b: { name: string }) => b.name === 'closed-ancient')
    expect(entry.bucket).toBe('martin_review')
    expect(entry.proposed_commands).toEqual([])
    expect(entry.reason).toContain('Martin')
  })

  it('never proposes anything for an open or unreferenced bundle, however old', () => {
    bundle('still-running', 400)
    bundle('never-seen', 400)
    journal('run-1', [worker('still-running', 'running')])

    const report = run()
    expect(bucketOf(report, 'still-running')).toBe('retain')
    expect(bucketOf(report, 'never-seen')).toBe('retain')
    expect(report.totals.archive_proposed).toBe(0)
    expect(report.totals.martin_review).toBe(0)
  })

  it('treats an unreadable journal as proving nothing rather than as closure', () => {
    bundle('closed-old', 30)
    journal('run-1', [worker('closed-old', 'completed')])
    writeFileSync(path.join(runs, 'broken.json'), '{not json')

    // The good journal still closes the bundle; the broken one adds no claim.
    expect(bucketOf(run(), 'closed-old')).toBe('archive_proposed')

    rmSync(path.join(runs, 'run-1.json'))
    expect(bucketOf(run(), 'closed-old')).toBe('retain')
  })

  it('refuses to be told to act', () => {
    bundle('closed-old', 30)
    journal('run-1', [worker('closed-old', 'completed')])

    for (const flag of ['--apply', '--delete', '--prune']) {
      let failed = false
      try {
        execFileSync('python3', [SCRIPT, '--root', evidence, '--journal-root', runs, flag], {
          encoding: 'utf8',
          stdio: 'pipe',
        })
      } catch (error) {
        failed = true
        const err = error as { status: number; stderr: string }
        expect(err.status).toBe(2)
        expect(err.stderr).toContain('never mutates')
      }
      expect(failed).toBe(true)
    }

    // And the bundle is still there afterwards.
    expect(run().bundles).toHaveLength(1)
  })

  it('leaves every byte of the evidence root in place', () => {
    bundle('closed-old', 30, { 'native-terminal.json': { status: 'completed' }, 'REPORT.md': {} })
    journal('run-1', [worker('closed-old', 'completed')])

    const before = execFileSync('find', [evidence, '-type', 'f'], { encoding: 'utf8' })
    run()
    expect(execFileSync('find', [evidence, '-type', 'f'], { encoding: 'utf8' })).toBe(before)
  })
})
