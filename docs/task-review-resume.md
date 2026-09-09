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

Roots are fixed at runtime and injectable **only** from tests
(`reconcileNativeTerminalEvidence(request, deps)` in `src/lib/task-review-resume.ts`);
a request can never choose a path. Reading is bounded: at most 400 journal
files, 512 KB per file, regular files only, symlinks rejected and every
resolved path must stay inside its trusted root.

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

A failed worker with an actual integer exit code (including 0 after failed result validation) is terminal evidence and is preserved;
resume does not require the review to have passed. Old terminal receipts are
accepted regardless of age.

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

One decoder distinguishes two kinds before applying the terminal proof rules:

- With no `schemaVersion` field, a receipt is `native`. Its existing top-level
  `status`, integer `exitCode` and `sessionRef`/`sessionId` rules are unchanged.
- With numeric `schemaVersion: 1`, a receipt is `wrapper`. An inline `native`
  object supplies the status, decision, `sourceThreadId` and child exit. A host
  observation instead supplies top-level status, wrapper exit, decision and
  session reference, plus `nativeResultRef`. That reference is read with the
  same roots, file-size bound, symlink refusal and resolved containment check.
  It must decode directly as a version 1 wrapper with an inline native result;
  another host observation or an unversioned native receipt is refused.
- Any present `schemaVersion` other than numeric `1` is refused with
  `receipt_mismatch`; the server log detail names the unsupported version.

A wrapper needs a terminal status matching the journal worker and matching
session identity. A full `sessionRef` must equal the journal reference; a bare
`sourceThreadId` must match its `:`-prefixed suffix. At least one identity is
required, and every supplied identity must agree. Referenced native evidence
must independently match the journal session. The native status must be
terminal and equal the wrapper status, and `childExit.observed` must be exactly
`true` with an integer `childExit.code`. Native `completed` requires exit `0`;
native `failed` and `cancelled` accept any integer exit.

A release wrapper's non-zero exit on **HOLD** is normal. Terminal proof comes
from the observed native child exit read from evidence. The wrapper exit is
preserved as `wrapper_exit_code`, including `1`; the native exit is preserved
as `receipt_exit_code`. `review_decision` records the decision but is never
proof: neither `pass` nor `hold` can replace observed terminal child evidence.
**Resume is not approval.** The summary also records `receipt_kind` and
`receipt_schema_version`; unversioned receipts have null version, wrapper exit
and review decision.

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
