# Evidence retention

Mission Control proves a review may be resumed by reading native terminal
receipts off disk (see [task-review-resume.md](./task-review-resume.md)). Those
receipts have historically lived under `~/tmp`, one directory per controller
run. That is a real problem, not a cosmetic one: a directory named `tmp` is what
every disk sweep, every retention script and every tired operator is entitled to
treat as disposable, and the receipts in it are the only thing standing between
a HOLD/PASS judgement and an unprovable claim.

This document covers the two halves of the fix: where evidence is allowed to
live, and what may be done to it as it ages.

## `MC_EVIDENCE_ROOT`

`defaultResumeEvidenceDeps()` (`src/lib/task-review-resume.ts`) returns the
canonical roots the reconciler trusts. It always trusts `~/tmp`. When
`MC_EVIDENCE_ROOT` is set to an absolute path to an existing directory, that
directory is trusted **as well**.

```bash
MC_EVIDENCE_ROOT=/Users/<user>/.openclaw/mission-control/evidence
```

Additive, never replacing. Unsetting the variable restores exactly the previous
behaviour, and a deployment that never sets it behaves as it always did.

### Why a symlink into the root works

Containment has always been checked on the **resolved** path
(`realpathSync`), not the literal one. That is what makes the following safe and
what makes it work at all:

```
~/tmp/<run-id>            ->  $MC_EVIDENCE_ROOT/<run-id>     (symlink)
journal receiptRef        ->  ~/tmp/<run-id>/native-terminal.json
realpath(receiptRef)      ->  $MC_EVIDENCE_ROOT/<run-id>/native-terminal.json
```

With `MC_EVIDENCE_ROOT` configured the resolved path is inside a trusted root
and the receipt is accepted. Without it, the same path resolves outside every
trusted root and the reconciler returns `receipt_mismatch`. This was measured
before the change rather than assumed:

> `CASE A (receiptRoots=[~/tmp])`
> `{"ok":false,"code":"receipt_mismatch","detail":"... receipt: outside the trusted roots"}`

**Consequence, and it is the load-bearing one:** evidence must not be relocated
out of `~/tmp` until a Mission Control carrying this change is deployed _and_
`MC_EVIDENCE_ROOT` is set. Move the directories first and every recorded
`receiptRef` stops proving anything — the receipts are still on disk, still
correct, and no longer reachable. Order is: deploy, set the variable, verify a
resume, then migrate.

### What this does not loosen

Adding a root widens _where evidence may live_. It does not widen _what counts
as proof_:

- the receipt file itself must still be a regular file, not a symlink
- the path must still be absolute and free of `..`
- the resolved path must still fall inside one of the trusted roots — a
  symlink that escapes every root is still refused
- receipt status, exit code and session identity must still agree with the
  journal

An unusable value (relative, missing, containing `..`) is **ignored** rather
than fatal, so a typo degrades to the previous behaviour instead of making every
review unresumable.

An over-broad or disposable value is ignored too. After `realpath`
normalisation the root is trusted **only when it lies strictly under `$HOME`**
and is not itself a sweepable location. Refused, with the reason:

| Value | Why it is refused |
| --- | --- |
| `/` | contains everything, so containment would mean nothing |
| `$HOME` | trusts the entire home directory |
| `/Users`, or any other ancestor of `$HOME` | strictly wider than the `$HOME` case above |
| `/tmp/...`, `/private/tmp/...` | outside `$HOME`, and clearable by any disk sweep |
| `~/tmp`, and anything under it | the disposable root this variable exists to escape |

An earlier version of this paragraph described the breadth rule generally while
the code only compared for equality against `/`, `$HOME` and `~/tmp` — so
`MC_EVIDENCE_ROOT=/Users` was cleared and quietly widened containment to the
whole home directory. The rule is now a containment test rather than a list of
values, and the table above is the list it produces.

Accepted, and the value this variable exists for:
`$HOME/.openclaw/mission-control/evidence`. All of this is pinned in
`src/lib/__tests__/task-review-resume.test.ts`.

## `scripts/evidence-retention.py`

A durable evidence root grows without bound unless something proposes what to do
with it. This script does the proposing — and only the proposing.

```bash
scripts/evidence-retention.py                    # human-readable
scripts/evidence-retention.py --json             # machine-readable
scripts/evidence-retention.py --root DIR         # audit another root
```

**It never deletes, moves or compresses anything.** Passing `--apply`,
`--delete`, `--prune` or similar exits 2 with an explanation rather than doing
what was asked. Removing evidence is an approval gate that belongs to Martin;
the script's job is to hand him an exact, verifiable command list.

### Classification

A bundle's state comes from the controller journal, never from its name or age:

| State          | Meaning                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `closed`       | every journal worker whose receipt lives in the bundle is terminal (`completed`, `failed`, `cancelled`) |
| `open`         | the journal records a non-terminal worker for the bundle                                                |
| `unreferenced` | the journal never mentions the bundle                                                                   |

Only `closed` bundles are ever proposed for anything. `open` and `unreferenced`
are retained — a bundle the journal cannot speak for is one we do not
understand, and uncertainty preserves. An unreadable journal file is skipped
rather than trusted, so a corrupt journal can only make a bundle look _less_
closed, never more.

### Buckets

| Bucket             | Rule                                              | Proposal                            |
| ------------------ | ------------------------------------------------- | ----------------------------------- |
| `retain`           | not closed, or younger than `--archive-days` (14) | nothing                             |
| `archive_proposed` | closed, older than 14 days                        | `tar --zstd` plus a sha256 manifest |
| `martin_review`    | closed, older than `--review-days` (90)           | flagged; no commands emitted        |

The archive proposal writes the hash manifest **before** compressing and reads
the archive back afterwards, so losslessness is demonstrated rather than
assumed. This mirrors the MC1308 bundle compression, where 14 598 per-file
checks accompanied a 0.36 GiB saving.

### A caveat worth knowing before trusting the numbers

`du` is not a promise about disk. Evidence bundles routinely contain APFS clones
of a shared `node_modules` or checkout, and deleting a clone frees nothing until
the last clone in the set goes. Measured on 2026-09-09: removing 2.83 GiB of
`du`-reported `node_modules` from two closed bundles returned **0.05 GiB** of
actual free space, because the blocks were shared with the still-live hub
checkout that must stay. Always confirm a reclaim with `df`, never with `du`.

## Related

- `src/lib/task-review-resume.ts` — the reconciler and its roots
- `src/lib/__tests__/task-review-resume.test.ts` — root configuration and containment tests
- `src/lib/__tests__/evidence-retention.test.ts` — retention classification and the refusal to act
- [task-review-resume.md](./task-review-resume.md) — the resume-review contract
