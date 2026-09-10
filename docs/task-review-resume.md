# POST /api/tasks/[id]/resume-review

Recovers a review ticket that was Released while its review was still
unfinished. `Released` is not claimable and `/requeue` only accepts
`Claimed`/`Running`, so such a ticket previously had no supported way back into
the queue. This endpoint performs one narrow transition, `Released →
Unclaimed`, and changes nothing about claim, release or requeue semantics.

## Contract

**Auth:** operator role or higher, same as claim/release/requeue. All reads and
writes are scoped to the authenticated workspace. Rate limited by the shared
mutation limiter.

**Body**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `reason` | string | yes | Nonempty after trimming, stored verbatim (max 500 chars) in the audit record |
| `expected_updated_at` | integer | yes | The `tasks.updated_at` the caller observed; anything else is a stale revision |

**Preconditions** (all re-checked inside the write transaction)

- task exists in the authenticated workspace
- `status` is `review` or `quality_review` — never `done`, `failed` or any other terminal state
- `claim_state` is `Released`
- `claimed_by` **and** `claimed_at` are both `NULL` — a residual or active owner is rejected
- `updated_at` equals `expected_updated_at`
- server-reconciled native worker evidence (below) passes

**Responses**

| Status | Meaning |
| --- | --- |
| 200 | `{ task, resumed_by, reason, evidence }` — transition applied |
| 400 | invalid task id, missing/blank `reason`, missing/non-integer `expected_updated_at` |
| 401/403 | unauthenticated, or below operator |
| 404 | task not found in this workspace |
| 409 | wrong status/claim state, owner still recorded, stale revision, concurrent duplicate, or unproven evidence (`evidence_code` set) |

Every 409 leaves the row untouched.

## Evidence reconciliation

The caller cannot assert that its workers stopped. The server reads the
canonical local controller journal itself:

```
~/.openclaw/workspace/skills/babysential-backlog-orchestrator/.state/runs/*.json
```

Two classes of receipt root are trusted:

```
~/tmp  (+ MC_EVIDENCE_ROOT, MC_RECEIPT_ROOTS)          legacy receipts and host observations
~/.openclaw/state/babysential-codex-review/perPR       native Codex review receipts
```

The native review root is **fixed** — no environment variable widens it, and a
native result outside it is refused. The legacy roots are the operator's:
`~/tmp` is always trusted, and `MC_EVIDENCE_ROOT`/`MC_RECEIPT_ROOTS` add durable
directories under the rule in *Receipt roots* below. Roots are injectable **only**
from tests (`reconcileNativeTerminalEvidence(request, deps)` in
`src/lib/task-review-resume.ts`); a request can never choose a path.
Reading is bounded: at most 400 journal files, 512 KB per file, including native request/result metadata,
raw file buffers are hashed before decoding, malformed UTF-8 is rejected,
regular files only, symlinks rejected and every resolved path must stay inside
its trusted root.

Resume is allowed only when **all** of the following hold:

- the authenticated workspace is the primary workspace (workspace 1), which owns
  the shared local controller; any other workspace fails closed with
  `workspace_not_supported` and no filesystem detail
- at least one native worker is recorded for the task
- every worker for that task, in every journal (including later runs), has a
  terminal status: `completed`, `failed` or `cancelled`
- each journal containing workers for the task declares the same project as the
  task and the primary workspace
- each worker has a `receiptRef` and `sessionRef`, and the referenced native
  terminal receipt matches: same terminal status, an actual exit code
  (`completed` ⇒ `0`, `failed`/`cancelled` ⇒ any integer exit code) and the same session
- a passed `deadlineAt` is never treated as proof and is not read

A failed worker with an actual integer exit code (including 0 after failed result validation) is terminal evidence and is preserved. Version 2 and 3 native results may instead preserve an observed termination signal with a null code. The signal must be an own entry in the host operating system signal table. Empty, unknown and inherited property names are rejected. An unobserved exit, missing outcome, or simultaneous code and signal remains blocked. Resume does not require the review to have passed. Old terminal receipts are accepted regardless of age.

## Receipt shapes

Three receipt shapes are accepted. The shape is chosen by discriminator, never
by trial: if a receipt carries the native host-observation `kind`, `nativeResultRef`, `native` or
`requestSha256`, it is committed to the strict native reader. A malformed
native receipt is rejected — it never falls back to the lax flat matcher.

### 1. Flat Claude receipt (legacy, unchanged)

`{ status, exitCode, sessionId?, sessionRef? }` under `~/tmp`. Rules are exactly
as before: `completed` ⇒ `exitCode 0`, every supplied identity field must agree,
and `completed ⇒ exit 0` was **not** loosened for these.

### 2. Raw native Codex result (versions 1, 2 and 3)

The controller points `receiptRef` straight at the immutable

```
<perPR>/<positive PR number>/<canonical lowercase uuid>/result.json
```

with its sibling `request.json`. The layout is strict: exactly that depth, that
filename, a numeric PR directory and a canonical UUID run directory, all inside
the fixed native root. A raw result found anywhere else is not trusted, and a
flat receipt found *inside* the native root is rejected.

Request and result `schemaVersion` must match exactly and be one of `1`, `2` or `3`. There is no downgrade or best-effort parser. Version 1 retains the historical completed/pass/HOLD contract. Versions 2 and 3 additionally bind `profileRef`, `expectedPlanType` and `codexHomeSha256` between request and result, and to every corresponding journal route/dispatch value that is supplied. Plus requires a SHA-256 home hash; Pro requires an explicit null home hash. A controller `bindingId` names the compute binding and is not treated as a profile reference. The registered account and model remain authoritative journal bindings.

An explicitly supplied null home in either the journal route or dispatch is a binding, not an omitted field. It must match the request's home value. Contradictory bindings cannot recover a Plus review lifecycle; historical journals that omit the optional field retain their existing compatibility.

All of the following must hold:

- `sha256(raw request.json bytes) == result.requestSha256`
- `request.runId == result.runId == <uuid directory>`
- `request.candidate.prNumber == <PR directory>`
- `request.taskRef == "MC:<taskId>"` for the task being resumed
- `native.requestedModel == native.observedModel == request.model`, and the
  journal's every supplied route/dispatch model when recorded; supplied account IDs must also match
- `native.accountBefore.emailHash == request.expectedEmailHash`; completed results require the matching `accountAfter`, while a version 2 or 3 operational failure may omit it. Any present second read must match the requested identity and first read. Version 2 and 3 account plan types must match `expectedPlanType`.
- `native.sourceThreadId == native.reviewThreadId == native.terminal.threadId`,
  and the registered worker `sessionRef` binds that thread id
- completed results require `native.turnId == native.terminal.turn.id`, notification `turn/completed`, mechanism `turn/start+outputSchema`, and a completed turn. A version 2 or 3 operational failure may omit `terminal`; if present it must still match the exact source thread and turn.
- `native.childExit.observed == true`; completed results and all version 1 results require an integer code and null signal. Version 2 and 3 failed/cancelled results may carry an integer code or an actual signal with nullable code. Exactly one outcome must be present; a signal must exist in the host operating system signal table.
- `native.status` is terminal and equals the journal worker status, except native `timeout` maps only to controller `failed` and remains `timeout` in provenance. Completed requires exit code `0` and no signal.
- completed and version 1 results require `native.errorCode == null`. A version 2 or 3 operational failure requires an error code and `childLifecycle.state == "exited"`. No result may report leaving review mode.
- `gitBefore`/`gitAfter` are clean and equal `request.candidate.headSha/treeSha`;
  `baseSha`, `treeSha`, `policyCommit` and `policySha256` must be well formed
- completed and version 1 results require `native.decision == native.review.decision`, recorded verbatim. A version 2 or 3 operational failure may omit both. It may never pair failure with PASS or provide only one of decision/review.

### 3. Derived host observation (MC1305 shape)

A summary under `~/tmp` with
`kind: "host_observation_of_native_release_review"`. It is a convenience
pointer, not evidence. Exactly one `nativeResultRef` is followed, it must
resolve to a raw native result inside the fixed native root, and every field
the observation copies is re-verified against the authoritative
request/result pair: `runId`, `pr`, `task`, `headSha`, `decision`, `status` and
`sessionRef`. Chained observations, pointers outside the native root and
traversal paths are refused. There is no generic auto-adapter and no recursive
following.

Its `exitCode` is the **wrapper's decision exit** — the release CLI exits
non-zero on HOLD. It is recorded as `wrapper_exit_code`/`wrapper_exit_meaning`
and never substituted for the native child exit. `exitCodeMeaning` is
descriptive and optional: MC1297's PASS observations predate it, and an absent
value is recorded as `wrapper_exit_meaning: null`.

## What the evidence means

For native receipts each reconciled worker gains an optional, path-free
`native` block alongside the existing `ReconciledWorker` fields:

| Field | Meaning |
| --- | --- |
| `evidence_kind` | `native_result` or `host_observation_of_native_release_review` |
| `native_status` | the native run's own terminal status |
| `child_exit_code` / `child_exit_signal` | the **observed** exit of the reviewer child process; code is nullable only when an actual signal is preserved |
| `wrapper_exit_code` / `wrapper_exit_meaning` | the wrapper CLI's decision exit, `null` for a raw result |
| `review_decision` | the review verdict, e.g. `hold`, copied verbatim; null for an operational failure that produced no verdict |
| `native_run_id`, `pr_number`, `head_sha`, `task_ref` | the candidate the run was bound to |
| `observed_model`, `thread_id`, `turn_id` | reviewer identity |
| `request_sha256` | SHA-256 of the raw `request.json` bytes, verified |
| `result_digest` / `wrapper_digest` | SHA-256 of the raw source / wrapper bytes |

`receipt_exit_code` keeps its existing meaning — the exit that proves *this
worker's* process ended — so for native receipts it is the child exit and may be null when `native.child_exit_signal` carries the observed outcome.
`receipt_status` is the native status and `receipt_digest` remains SHA-256 of
canonical parsed JSON of the receipt the journal referenced. `receipt_refs` may
contain two entries for one worker when an observation was followed: the
observation and the authoritative result it was checked against.

**Limits.** Three facts are deliberately kept apart and none implies another:
the review *decision*, the wrapper CLI *gate exit*, and the native *process*
completion. Resume proves only the third. A missing decision stays null. A HOLD stays a HOLD: it is preserved
in the audit and this endpoint never converts it to a pass, never approves a
release and never re-runs a review. Nothing in the source receipts, the
`request.json`/`result.json` pair or the controller journal is rewritten,
repaired or normalized — they are read-only inputs. The reconciler proves that
recorded workers stopped; it does not supervise unregistered processes, and
`operationalEvents`/`droppedEventCount` are not interpreted. A `result.json`
larger than 512 KB fails closed rather than being read partially.

`evidence_code` values: `workspace_not_supported`, `evidence_unavailable`,
`evidence_unreadable`, `scope_mismatch`, `worker_not_terminal`,
`receipt_mismatch`. Public errors carry the code and a generic message only —
local paths stay in the server log.

### Receipt roots

Receipt roots are ordered as `~/tmp`, the optional singular `MC_EVIDENCE_ROOT`,
then the comma-separated entries in `MC_RECEIPT_ROOTS`. The latter supports
durable wrapper locations such as
`$HOME/.openclaw/state/babysential-codex-review` and
`$HOME/.openclaw/state/babysential-codex-release`.

Both variables use the same breadth rule: each configured entry must be
absolute, contain no `..` segment, resolve to a directory strictly under the
resolved `$HOME`, and be neither `~/tmp`, `/tmp` nor anything under either
(including `/private/tmp` on macOS). Invalid or unusable entries are ignored
individually. Blank entries are skipped, duplicates by resolved path are
collapsed, and the total is capped at eight roots, including `~/tmp`.
Configured root strings retain their trimmed spelling and order. Receipt
containment is checked on resolved paths; a symlinked parent can lead into a
trusted root, but a receipt file that is itself a symlink is refused.

### Receipt formats

`classifyReceipt()` (`src/lib/native-review-terminal.ts`) picks the reader from
discriminators, never by trial — see *Receipt shapes* above. There is no
version-sniffing fallback: a receipt that looks native and fails validation is
refused rather than retried against the flat matcher.

A release wrapper's non-zero exit on **HOLD** is normal. Terminal proof comes
from the observed native child exit read from the authoritative `result.json`.
The wrapper's own exit is preserved as `native.wrapper_exit_code`, including
`1`; the proven child exit is `receipt_exit_code`. `native.review_decision`
records the verdict but is never proof: neither `pass` nor `hold` can replace
observed terminal child evidence. **Resume is not approval.**

## Durable audit

Inside the same transaction as the state change the endpoint:

- appends an entry to `metadata.review_resumes` (actor, reason, timestamp,
  from/to states, `expected_updated_at`, reconciled workers and receipt refs)
  while preserving all other metadata keys, prior receipts and history
- inserts a `task_review_resumed` row into `activities` for the workspace

`status`, `retry_count` and `claimed_*` history are untouched. The broadcast on
`task.updated` happens after commit and cannot roll back the transition.

## Example

```http
POST /api/tasks/1301/resume-review
{ "reason": "All prior native workers reconciled terminal; PR unchanged",
  "expected_updated_at": 1788889826 }
```

After 200 the ticket is `Unclaimed` and `POST /api/tasks/1301/claim` succeeds
normally. A new dispatch registration still requires `Claimed`/`Running`, so a
Released ticket cannot acquire a new registered worker before this transition.

Integrator corrections: receipt identity fields must all agree, receipt digests cover canonical JSON content, temporary receipt roots are narrower than the home directory, existing malformed resume history fails closed, and task IDs/revisions must be safe integers. A failed worker with exit 0 is terminal when its child finished but result validation failed; this does not mark its review approved.

The evidence summary and errors omit filesystem paths. The authenticated primary-workspace task response and task.updated broadcast retain the stored audit references inside metadata, as existing scoped task reads do. Safety between journal reconciliation and the conditional database write depends on every native launch requiring a prior MC claim and registered worker; this endpoint does not supervise unregistered processes. `receipt_digest` is SHA-256 of canonical parsed JSON, not raw file bytes. For host observations it covers both parsed files as `{ receipt, nativeResult }`; unversioned receipt digests are unchanged. More than 400 journals fails closed; reconcile/archive controller history deliberately with preserved receipts before that bound, never delete live or unknown worker evidence.
