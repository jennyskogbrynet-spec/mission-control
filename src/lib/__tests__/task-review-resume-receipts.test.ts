// @vitest-environment node
/**
 * Operator-configured legacy receipt roots (`MC_RECEIPT_ROOTS`).
 *
 * The versioned wrapper-decoder cases that used to live here were dropped when
 * MC1320's stricter native reader (`native-review-terminal.ts`) took over the
 * semantics; see docs/task-review-resume.md. The historical fixtures are kept
 * because their provenance is documented and one of them is exercised below.
 */
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
    // These cases are about the operator-configured *legacy* roots. The fixed
    // native review root is absent on purpose, so it resolves to nothing and
    // every receipt below is classified and proven on the legacy path.
    nativeReviewRoot: path.join(home, 'no-native-review-root'),
  })
}

function expectRefused(code = 'receipt_mismatch') {
  const result = reconcile()
  expect(result).toMatchObject({ ok: false, code })
  if (!result.ok) expect(result.message).not.toContain('/')
  return result
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
