# Receipt fixtures — provenance

These are **real historical receipts** produced by the babysential release/review
pipeline on 2026-09-08/09, copied here so the resume-review decoder is tested
against the formats that actually locked MC1304 and MC1305, not against
hand-written approximations.

Copied and scrubbed by `claude-code/mc-improve-G3` on 2026-09-09.

**Status after the MC1320 integration (2026-09-09).** MC1320's stricter reader
(`src/lib/native-review-terminal.ts`) validates the authoritative
`request.json`/`result.json` pair by raw-byte digest and by account identity, so
a *scrubbed* wrapper receipt can no longer be replayed as passing evidence —
that is the reader working as designed, not a regression. The versioned-decoder
tests that consumed these files were therefore dropped when the two
implementations were merged; `mc1304-native-claude-opus.json` (a flat legacy
receipt) is still exercised by `task-review-resume-receipts.test.ts`. The rest
are kept because their provenance below is verified and because the native
reader's own cases are built from synthetic pairs in
`task-review-resume.test.ts`, where the digests can be computed honestly.

## Scrubbing rules applied (identical for every file)

| Field                                                             | Action                                | Why                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `native.accountBefore.emailHash`, `native.accountAfter.emailHash` | replaced with `<scrubbed-email-hash>` | account-identifying                                                                                              |
| `accountId`                                                       | replaced with `<scrubbed-account-id>` | account-identifying                                                                                              |
| `toolCalls[]`                                                     | truncated to the first 3 entries      | volume only; the decoder never reads it                                                                          |
| `native.operationalEvents[]`                                      | truncated to the first 5 entries      | volume only; the decoder never reads it                                                                          |
| everything else                                                   | **verbatim**                          | structure, `status`, `exitCode`, `decision`, `childExit`, session ids and timestamps are the evidence under test |

No API keys, tokens, passwords or e-mail addresses were present in any source
file (scanned before copying); the two replacements above are precautionary.

`nativeResultRef` keeps its original absolute path. A test that exercises the
referenced-native-result path must rewrite it to point at the fixture it
materialises inside its own scratch root — the literal path is kept so the
fixture stays a faithful copy of what the journal recorded.

## Files

| Fixture                                   | Source path                                                                                             | Shape                                                                   | Key evidence                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mc1304-native-claude-opus.json`          | `~/tmp/babysential-1304-20260908T2333/opus-implementation/native-terminal.json`                         | native CLI receipt                                                      | `status: completed`, `exitCode: 0`, `sessionRef: claude-code:02b932a0-…`                                                                                                                                                                                                                          |
| `mc1304-native-claude-fable.json`         | `~/tmp/babysential-1304-20260908T2333/fable-review/native-terminal.json`                                | native CLI receipt                                                      | `status: completed`, `exitCode: 0`, `sessionRef: claude-code:b2cf90aa-…`                                                                                                                                                                                                                          |
| `mc1304-wrapper-codex-pr436-hold.json`    | `~/.openclaw/state/babysential-codex-review/perPR/436/6807bc77-4193-4490-b16a-370b81e5cc67/result.json` | wrapper result, `schemaVersion: 1`, native nested inline                | no top-level `status`/`exitCode`; `native.status: completed`, `native.decision: hold`, `native.childExit: {observed:true, code:0}`, `native.sourceThreadId: 01a08637-…`. This is the receipt the journal records for MC1304 worker `a327cdc0-…`, and the one today's decoder cannot parse at all. |
| `mc1305-host-observation-pr437-hold.json` | `~/tmp/mc-improve-laneA-receipts/pr437-review-1.json`                                                   | wrapper host observation, `schemaVersion: 1`, native referenced by path | `status: completed`, **`exitCode: 1`**, `decision: hold`, `sessionRef: codex:01a08654-…`, `nativeResultRef` → the file below. This is the receipt today's decoder rejects because `completed` ⇒ `exitCode 0`.                                                                                     |
| `mc1305-wrapper-codex-pr437-hold.json`    | `~/.openclaw/state/babysential-codex-review/perPR/437/fe048d7c-70e1-4946-9b9b-dc1134de61f0/result.json` | wrapper result, native nested inline                                    | `native.status: completed`, `native.decision: hold`, `native.childExit: {observed:true, code:0}` — the actual native child exit that the wrapper's own exit 1 hides.                                                                                                                              |
| `mc1297-host-observation-pr438-pass.json` | `~/tmp/mc-improve-laneA-receipts/pr438-review-3-pass.json`                                              | wrapper host observation                                                | `status: completed`, `exitCode: 0`, `decision: pass`, `nativeResultRef` → the file below. The PASS counterpart of the HOLD case.                                                                                                                                                                  |
| `mc1297-wrapper-codex-pr438-pass.json`    | `~/.openclaw/state/babysential-codex-review/perPR/438/c8a685f7-d7d3-467b-b9f1-8b3cfe77fd52/result.json` | wrapper result, native nested inline                                    | `native.decision: pass`, `native.childExit: {observed:true, code:0}`                                                                                                                                                                                                                              |
| `mc1297-native-claude-failed.json`        | `~/tmp/babysential-1297-20260909T0540/opus-implementation/native-terminal.json`                         | native CLI receipt                                                      | `status: failed`, `exitCode: 143` — a terminal _failed_ worker, which resume-review must still accept as terminal evidence.                                                                                                                                                                       |

## Journal correspondence (2026-09-09)

`~/.openclaw/workspace/skills/babysential-backlog-orchestrator/.state/runs/*.json`
records, for these tasks:

- MC1304: `2e896566-….json` → worker `a327cdc0-…`, `sessionRef codex:01a08637-…`,
  `receiptRef` = the perPR/436 wrapper result above; `49f54f4c-….json` → two
  `claude-code:` workers with the two native receipts above.
- MC1305: `8487af52-….json` → two `codex:` workers whose receipts are the
  `~/tmp/mc-improve-laneA-receipts/pr437-review-{1,2}.json` host observations;
  `1a39eddc-….json` → two `claude-code:` native workers.
- MC1297: `8433bfc5-….json` and `a66a9121-….json` → `codex:` host observations;
  `8465d2b6-….json` and `d0fec34a-….json` → `claude-code:` native receipts,
  including the `failed` / exit 143 one.
