// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultResumeEvidenceDeps, reconcileNativeTerminalEvidence } from '../task-review-resume'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(actual.homedir) }
})

const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
const fixtures = path.join(__dirname, 'fixtures', 'receipts')
const request = { taskId: 1304, projectId: 2, workspaceId: 1 }
const sessionId = '01a08637-2625-7303-a89d-d8ca60674696'
const sessionRef = `codex:${sessionId}`
const savedEvidenceRoot = process.env.MC_EVIDENCE_ROOT
const savedReceiptRoots = process.env.MC_RECEIPT_ROOTS
let home = ''
let durable = ''
let runs = ''

function fixture(name: string) {
  return JSON.parse(readFileSync(path.join(fixtures, `${name}.json`), 'utf8'))
}

function writeReceipt(name: string, body: unknown, directory = durable) {
  const file = path.join(directory, `${name}.json`)
  writeFileSync(file, JSON.stringify(body))
  return file
}

function worker(receiptRef: string, ref = sessionRef, status = 'completed', taskId = request.taskId) {
  return { workerId: path.basename(receiptRef), taskId, status, sessionRef: ref, receiptRef }
}

function journal(workers: ReturnType<typeof worker>[], name = 'run', scope = {}) {
  writeFileSync(path.join(runs, `${name}.json`), JSON.stringify({
    id: name, projectId: request.projectId, workspaceId: 1, workers, ...scope,
  }))
}

function reconcile(taskId = request.taskId) {
  return reconcileNativeTerminalEvidence({ ...request, taskId }, {
    journalRoot: runs,
    receiptRoots: defaultResumeEvidenceDeps().receiptRoots,
  })
}

function expectRefused(code = 'receipt_mismatch') {
  const result = reconcile()
  expect(result).toMatchObject({ ok: false, code })
  if (!result.ok) expect(result.message).not.toContain('/')
  return result
}

function inlineReceipt() {
  return fixture('mc1304-wrapper-codex-pr436-hold')
}

function hostReceipt(nativeResultRef: string) {
  return {
    schemaVersion: 1,
    kind: 'host_observation_of_native_release_review',
    status: 'completed', exitCode: 0, decision: 'pass', sessionRef, nativeResultRef,
  }
}

beforeEach(() => {
  home = mkdtempSync(path.join(actualOs.homedir(), '.mc-receipts-test-'))
  vi.mocked(os.homedir).mockReturnValue(home)
  durable = path.join(home, '.openclaw', 'state', 'babysential-codex-review')
  runs = path.join(home, 'runs')
  mkdirSync(durable, { recursive: true })
  mkdirSync(runs)
  mkdirSync(path.join(home, 'tmp', 'nested'), { recursive: true })
  delete process.env.MC_EVIDENCE_ROOT
  delete process.env.MC_RECEIPT_ROOTS
})

afterEach(() => {
  vi.mocked(os.homedir).mockImplementation(actualOs.homedir)
  rmSync(home, { recursive: true, force: true })
  if (savedEvidenceRoot === undefined) delete process.env.MC_EVIDENCE_ROOT
  else process.env.MC_EVIDENCE_ROOT = savedEvidenceRoot
  if (savedReceiptRoots === undefined) delete process.env.MC_RECEIPT_ROOTS
  else process.env.MC_RECEIPT_ROOTS = savedReceiptRoots
})

describe('MC_RECEIPT_ROOTS', () => {
  it('trusts a durable state root and reconciles a receipt inside it', () => {
    const body = fixture('mc1304-native-claude-opus')
    journal([worker(writeReceipt('native', body), body.sessionRef)])
    expectRefused()
    process.env.MC_RECEIPT_ROOTS = durable
    expect(defaultResumeEvidenceDeps().receiptRoots).toEqual([path.join(home, 'tmp'), durable])
    expect(reconcile().ok).toBe(true)
  })

  it('ignores each broad or disposable root while retaining a valid sibling', () => {
    // /Users, home and the system tmp paths fail the strictly-under-$HOME rule.
    // Only home/tmp and home/tmp/nested exercise the disposable-root rule.
    for (const invalid of ['/Users', home, path.join(home, 'tmp'), path.join(home, 'tmp', 'nested'), '/private/tmp', '/tmp']) {
      process.env.MC_RECEIPT_ROOTS = `${invalid},${durable}`
      expect.soft(defaultResumeEvidenceDeps().receiptRoots, invalid).toEqual([path.join(home, 'tmp'), durable])
    }
  })

  it('ignores nonexistent and non-directory entries without discarding valid entries', () => {
    const file = writeReceipt('file-is-not-root', {})
    process.env.MC_RECEIPT_ROOTS = `${home}/missing,${durable},${file},relative/path,${durable}/../babysential-codex-review`
    expect(defaultResumeEvidenceDeps().receiptRoots).toEqual([path.join(home, 'tmp'), durable])
  })

  it('appends roots in order and collapses blanks, duplicates and resolved aliases', () => {
    const evidence = path.join(home, 'evidence')
    mkdirSync(evidence)
    const alias = path.join(home, 'alias')
    symlinkSync(durable, alias)
    process.env.MC_EVIDENCE_ROOT = evidence
    process.env.MC_RECEIPT_ROOTS = ` , ${durable} ,${evidence},${durable}/,${alias},,${runs}`
    expect(defaultResumeEvidenceDeps().receiptRoots).toEqual([path.join(home, 'tmp'), evidence, durable, runs])
  })

  it('caps the total accepted receipt roots at eight', () => {
    const roots = Array.from({ length: 12 }, (_, index) => path.join(home, `root-${index}`))
    roots.forEach((root) => mkdirSync(root))
    process.env.MC_EVIDENCE_ROOT = roots[0]
    process.env.MC_RECEIPT_ROOTS = roots.slice(1).join(',')
    expect(defaultResumeEvidenceDeps().receiptRoots).toEqual([path.join(home, 'tmp'), ...roots.slice(0, 7)])
  })
})

describe('versioned historical review receipts', () => {
  beforeEach(() => {
    // Isolate decoder regressions from the new root variable's acceptance.
    process.env.MC_EVIDENCE_ROOT = durable
    process.env.MC_RECEIPT_ROOTS = durable
  })

  it('reconciles MC1304 inline HOLD and native receipts across every journal', () => {
    delete process.env.MC_EVIDENCE_ROOT
    journal([worker(writeReceipt('wrapper', inlineReceipt()))])
    const natives = ['mc1304-native-claude-opus', 'mc1304-native-claude-fable'].map((name) => {
      const body = fixture(name)
      return worker(writeReceipt(name, body), body.sessionRef)
    })
    journal(natives, 'earlier-run')
    const result = reconcile()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.journal_count).toBe(2)
    expect(result.workers).toHaveLength(3)
    expect(result.workers.find((w) => w.session_ref === sessionRef)).toMatchObject({
      status: 'completed', receipt_exit_code: 0, wrapper_exit_code: null,
      receipt_kind: 'wrapper', receipt_schema_version: 1, review_decision: 'hold',
    })
    expect(JSON.stringify(result.workers)).not.toContain(home)
  })

  it('reconciles MC1305 host HOLD while preserving wrapper exit 1 and native exit 0', () => {
    const native = fixture('mc1305-wrapper-codex-pr437-hold')
    const host = fixture('mc1305-host-observation-pr437-hold')
    host.nativeResultRef = writeReceipt('native-result', native)
    journal([worker(writeReceipt('host', host), host.sessionRef, 'completed', 1305)])
    const result = reconcile(1305)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workers[0]).toMatchObject({
      status: 'completed', receipt_exit_code: 0, wrapper_exit_code: 1,
      receipt_kind: 'wrapper', receipt_schema_version: 1, review_decision: 'hold',
    })
    expect(JSON.stringify(result.workers)).not.toContain(home)
  })

  it('reconciles MC1297 mixed PASS receipts and preserves the failed native exit 143', () => {
    const native = fixture('mc1297-wrapper-codex-pr438-pass')
    const host = fixture('mc1297-host-observation-pr438-pass')
    const failed = fixture('mc1297-native-claude-failed')
    host.nativeResultRef = writeReceipt('native-result', native)
    journal([
      worker(writeReceipt('host', host), host.sessionRef, 'completed', 1297),
      worker(host.nativeResultRef, host.sessionRef, 'completed', 1297),
    ])
    journal([worker(writeReceipt('failed', failed), failed.sessionRef, 'failed', 1297)], 'failed-run')
    const result = reconcile(1297)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.workers).toHaveLength(3)
    expect(result.workers.find((w) => w.status === 'failed')).toMatchObject({
      receipt_status: 'failed', receipt_exit_code: 143, receipt_kind: 'native',
      receipt_schema_version: null, wrapper_exit_code: null, review_decision: null,
      receipt_digest: createHash('sha256').update(JSON.stringify(failed)).digest('hex'),
    })
    expect(result.workers.find((w) => w.worker_id === 'host.json')).toMatchObject({
      receipt_exit_code: 0, wrapper_exit_code: 0, review_decision: 'pass',
    })
  })

  it('refuses a live worker in a later journal even when the wrapper is terminal', () => {
    const ref = writeReceipt('wrapper', inlineReceipt())
    journal([worker(ref)])
    journal([worker(ref, sessionRef, 'running')], 'later-run')
    expectRefused('worker_not_terminal')
  })

  it.each(['hold', 'pass'])('refuses decision %s without observed native child evidence', (decision) => {
    const body = inlineReceipt()
    body.native.decision = decision
    delete body.native.childExit
    journal([worker(writeReceipt('wrapper', body))])
    expectRefused()
    // A successful host process and a decision cannot substitute for child evidence either.
    journal([worker(writeReceipt('host', { ...hostReceipt(''), decision }))])
    expectRefused()
  })

  it.each([false, undefined])('refuses childExit.observed %s even when a zero code is present', (observed) => {
    const body = inlineReceipt()
    body.native.childExit.observed = observed
    journal([worker(writeReceipt('wrapper', body))])
    expectRefused()
  })

  it('refuses wrapper evidence from a foreign project', () => {
    journal([worker(writeReceipt('wrapper', inlineReceipt()))], 'run', { projectId: 99 })
    expectRefused('scope_mismatch')
  })

  it('refuses wrapper evidence from a foreign workspace', () => {
    journal([worker(writeReceipt('wrapper', inlineReceipt()))], 'run', { workspaceId: 2 })
    expectRefused('scope_mismatch')
  })

  it.each(['{not json', '{}', '{"schemaVersion":1}'])('refuses malformed or unrecognised receipt %s', (body) => {
    const ref = writeReceipt('malformed', {})
    writeFileSync(ref, body)
    journal([worker(ref)])
    expectRefused()
  })

  it.each([2, '1', null])('refuses unsupported schemaVersion %s with an explicit detail', (schemaVersion) => {
    journal([worker(writeReceipt('future', {
      ...hostReceipt(''), schemaVersion, native: inlineReceipt().native,
    }))])
    const result = expectRefused()
    if (!result.ok) expect(result.detail).toContain(`unsupported receipt schemaVersion ${JSON.stringify(schemaVersion)}`)
  })

  it.each(['outside', 'symlink', 'parent escape', 'traversal', 'oversized', 'malformed'])('refuses a referenced native result that is %s', (caseName) => {
    let ref = writeReceipt('native-result', inlineReceipt())
    if (caseName === 'outside' || caseName === 'parent escape') {
      const outside = path.join(home, 'outside')
      mkdirSync(outside)
      ref = writeReceipt('native-result', inlineReceipt(), outside)
      if (caseName === 'parent escape') {
        const link = path.join(durable, 'parent')
        symlinkSync(outside, link)
        ref = path.join(link, 'native-result.json')
      }
    } else if (caseName === 'symlink') {
      const link = path.join(durable, 'linked.json')
      symlinkSync(ref, link)
      ref = link
    } else if (caseName === 'traversal') {
      ref = `${durable}/../babysential-codex-review/native-result.json`
    } else if (caseName === 'oversized') {
      writeFileSync(ref, JSON.stringify({ ...inlineReceipt(), padding: 'x'.repeat(512_000) }))
    } else {
      writeFileSync(ref, '{broken')
    }
    journal([worker(writeReceipt('host', hostReceipt(ref)))])
    expectRefused()
  })

  it('refuses a second host observation instead of following a reference chain', () => {
    const native = writeReceipt('native-result', inlineReceipt())
    const secondHost = writeReceipt('second-host', hostReceipt(native))
    journal([worker(writeReceipt('host', hostReceipt(secondHost)))])
    expectRefused()
  })

  it('refuses an unversioned native result referenced by a wrapper host', () => {
    const native = writeReceipt('native-result', { status: 'completed', exitCode: 0, sessionRef })
    journal([worker(writeReceipt('host', hostReceipt(native)))])
    expectRefused()
  })

  it.each(['inline', 'host', 'referenced native'])('refuses a mismatched %s session', (location) => {
    const body = inlineReceipt()
    if (location !== 'host') body.native.sourceThreadId = 'different-session'
    const ref = writeReceipt('native-result', body)
    const host = hostReceipt(ref)
    if (location === 'host') host.sessionRef = 'codex:different-session'
    journal([worker(location === 'inline' ? ref : writeReceipt('host', host))])
    expectRefused()
  })

  it.each(['inline', 'referenced native'])('refuses missing %s identity', (location) => {
    const body = inlineReceipt()
    delete body.native.sourceThreadId
    const ref = writeReceipt('native-result', body)
    journal([worker(location === 'inline' ? ref : writeReceipt('host', hostReceipt(ref)))])
    expectRefused()
  })

  it.each([1, 0.5, null, '0'])('refuses completed native child exit %s', (code) => {
    const body = inlineReceipt()
    body.native.childExit.code = code
    journal([worker(writeReceipt('wrapper', body))])
    expectRefused()
  })

  it.each(['running', 'failed'])('refuses referenced native status %s when the host claims completed', (status) => {
    const body = inlineReceipt()
    body.native.status = status
    const ref = writeReceipt('native-result', body)
    journal([worker(writeReceipt('host', hostReceipt(ref)))])
    expectRefused()
  })

  it.each(['failed', 'cancelled'])('accepts observed %s native child exit 143 with wrapper exit 1', (status) => {
    const body = inlineReceipt()
    body.native.status = status
    body.native.childExit.code = 143
    body.exitCode = 1
    journal([worker(writeReceipt('wrapper', body), sessionRef, status)])
    expect(reconcile()).toMatchObject({ ok: true, workers: [expect.objectContaining({
      status, receipt_status: status, receipt_exit_code: 143, wrapper_exit_code: 1,
    })] })
  })

  it('includes referenced native evidence in the receipt digest', () => {
    const body = inlineReceipt()
    const ref = writeReceipt('native-result', body)
    journal([worker(writeReceipt('host', hostReceipt(ref)))])
    const before = reconcile()
    body.native.childExit.signal = 'changed-evidence'
    writeReceipt('native-result', body)
    const after = reconcile()
    expect(before.ok).toBe(true)
    expect(after.ok).toBe(true)
    if (before.ok && after.ok) expect(after.workers[0].receipt_digest).not.toBe(before.workers[0].receipt_digest)
  })
})
