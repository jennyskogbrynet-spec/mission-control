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

The evidence summary and errors omit filesystem paths. The authenticated primary-workspace task response and task.updated broadcast retain the stored audit references inside metadata, as existing scoped task reads do. Safety between journal reconciliation and the conditional database write depends on every native launch requiring a prior MC claim and registered worker; this endpoint does not supervise unregistered processes. `receipt_digest` is SHA-256 of canonical parsed JSON, not raw file bytes. More than 400 journals fails closed; reconcile/archive controller history deliberately with preserved receipts before that bound, never delete live or unknown worker evidence.
