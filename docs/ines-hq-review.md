# Independent Ines HQ review — 2026-09-08

**FINAL PASS, including shared evidence validation, protocol v4 and the final source-date precision correction. All eight reviewer findings are closed; the subsequent bounded corrections pass review and targeted tests. No remaining P1/P2 within scope. This verdict and the current consolidated fingerprints supersede earlier checkpoints.**

Reviewer: `independent_review`. Initial integrated review: 2026-09-07T23:47:08.138827+00:00. Final bounded review: 2026-09-08T00:10:31.414828+00:00. Base commit: `cc47ba6448eb2fd463d29624d49e1d6ab80e7766`; this verdict covers the source fingerprints below. Parent owns build, authenticated live/browser QA and activation/rollback verification; this is not a claim that deployment or all runtime checks are complete.

## Scope and method

Read-heavy review of the bounded vault/QMD adapter, role/workspace/tenant guard, HQ API routes, existing-task persistence and ticket counters, evidence/immutable learning, metrics provider/cache/query, UI forms/source reader/graphs/request lifecycle and HQ navigation. Included the subsequent task-board deep-link fix. Existing independently owned changes to scheduler, dispatcher, event bus and startup script were not reviewed as new HQ implementation.

Only this document and isolated fixtures under `/private/tmp/ines-hq-independent-review/` were written by this reviewer. Tests use temporary vault directories and in-memory SQLite, never the live task database or production vault. No server restart, environment-file change, provider credential read, external message or public publishing was performed by this reviewer.

## Findings closed

| # | Severity | Reproduced behavior | Verified correction |
|---|---|---|---|
| 1 | P2 | Knowledge API stripped `<project_id>`, `List<T>`, comparisons and fenced HTML from original Markdown. | `hq-knowledge.ts` returns the original allowed Markdown. Independent temp-vault replay is byte-for-byte faithful; renderer tests prevent raw HTML execution and image loading. |
| 2 | P2 | Identical learning replay returned 409 after task status/title/source changes; moving a task to another project created a second note ID. | `hq-evidence.ts` freezes learning title/status/sources/project. Both original status-change and moved-project fixtures now return the same immutable learning identity. |
| 3 | P2 | A matching legacy evidence entry without `createdAt` crashed when saving learning. | Existing evidence is normalized before use. The independent `{label, detail}` legacy fixture passes. |
| 4 | P2 | Generated learning was appended to original `source_ids`, producing a misleading learning → task “source” edge. | `learning_note_ids` / `learningNoteIds` are separate; graph emits original source → task and task → result/learning. Semantic graph and persisted-metadata tests pass. |
| 5 | P2 | Task UI promised saving without a source and allowed 300-character titles while the API required a source and max 200 characters. | Shared `hqTaskInputSchema` validates both layers. Source selection is required, field limits agree, suggested titles are bounded, and out-of-contract submits never POST. |
| 6 | P2 | Relative `/api/v1/runs/<id>/provenance` evidence URLs were silently discarded by the external-URL helper. | Dedicated UI evidence validator allows that exact internal route plus HTTP(S); arbitrary relative/protocol links are rejected. Rendered proof-link test and independent helper probe pass. |
| 7 | P2 | A shared note visible in a project's workspace disappeared when exact-title search completed. | Local search and QMD mapping use selected-project-plus-shared scope. Both engine regressions and the original independent temp-vault replay pass; other projects remain excluded. |
| 8 | P2 | Retained metric cards remained green “Oppdatert kilde” after a failed refresh despite a failure banner. | Error/retry display uses stored/unconfirmed status while retaining the original value/check time/API data. The independent render fixture changed from red to green. |

## Initial integrated independent verification

Executed after the eight original review corrections; subsequent bounded checks are recorded in the final addendum:

```bash
pnpm exec vitest run   src/lib/__tests__/hq-knowledge.test.ts   src/lib/__tests__/hq-knowledge-route.test.ts   src/lib/__tests__/hq-metrics.test.ts   src/lib/__tests__/hq-metrics-route.test.ts   src/lib/hq-operations.test.ts   src/components/headquarters/headquarters.test.tsx   src/lib/__tests__/use-task-deep-link.test.tsx
```

**82/82 tests passed in seven files:** 14 knowledge/route, 27 metrics/route, 11 SQLite operations, 23 UI and 7 task deep-link tests.

Additional reviewer fixtures:

```bash
pnpm exec vitest run --config /private/tmp/ines-hq-independent-review/vitest.config.mjs
pnpm exec vitest run --config /private/tmp/ines-hq-independent-review/ui-vitest.config.mjs
```

**4/4 independent SQLite replays and 1/1 independent stale-metric render test passed.** Direct exported-function probes additionally confirmed original Markdown fidelity, shared-note project search and the strict internal provenance-link rule. These fixtures were written independently from the implementation and reproduced their respective failures before correction.

Tests emitted existing Vite CJS/Browserslist age notices, with no test failure. No dependencies were upgraded for those notices.

## Behavior assessed

- **Access and privacy:** HQ guard checks existing minimum role, configured workspace and tenant before source access. Reads require viewer, mutations operator. SQL consistently scopes task/project data by workspace. Vault inputs use explicit subtrees, path/privacy exclusions, symlink confinement and a fresh selected-file check. QMD supplies ranking only for already-indexed allowed paths; private snippets/titles are not forwarded to the client.
- **Source fidelity:** Norwegian titles/aliases and code literals survive. Ambiguous note names and unresolved links are excluded rather than guessed. Source date is distinct from filesystem modification time. Opening frontmatter is hidden only by a conservative presentation helper; fetched source content is untouched. Inline code, later horizontal rules and malformed metadata remain visible.
- **Persistence:** The existing task/project/activity tables are reused. Idempotency check, ticket allocation, task insert and activity insert share a transaction. Exact replay creates one task/ticket and leaves status inbox. Evidence recording preserves task status and does not imply measured product effect. Learning writes use confined paths, exclusive/no-follow creation and content comparison; an owner's manual revision is preserved.
- **Graph and task navigation:** Original inputs and later results have different directed relationships. Missing graph endpoints are not invented; bounded graph/list counts are explicit. Task-board links resolve via the authenticated detail endpoint rather than depending on list pagination, and current URL/user/workspace/tenant scope gates prevent stale detail display.
- **Metrics:** Fixed provider-host allowlist, redirect rejection and sanitized errors protect the server credential. Only six aggregate cells are accepted. Thirty completed UTC days and the mature 24-hour first-popup cohort are defined explicitly; tracking IDs/events are not mislabeled as verified people. Missing/invalid sources yield null/unavailable; real zero survives. Provider freshness, cache age, source ownership and the newsletter-event mismatch are visible. The provider URL is labeled as a project link, not an exact saved-report URL.
- **UI lifecycle:** Stale responses cannot replace a newer selected document even if a fetch mock ignores abort. Unmount aborts pending requests. Uncertain task creation retains its exact idempotency key and locks edits until resolved. Evidence submission carries observations rather than a fabricated done status. Failed/refetching metrics show retained data as unconfirmed, with original check times.
- **Usability scope:** Forms use labels/native dialog and validation; graph has accessible button/list navigation and a 3D fallback. Existing UI tests exercise functional interactions, not a complete browser accessibility audit. The 200-task summary is now labeled as a prioritized sample, not an exhaustive total.

## Limits of this verdict

Parent owns the build/type/lint record, authenticated runtime read/write/readback proof, desktop/mobile/browser checks and running-version activation/rollback evidence. Its latest reported successful build, 137-test run and browser gateway connection are distinguished from this reviewer’s independently executed checks below. The reviewer did not perform a live network query, open a provider credential, verify product uplift or validate every unrelated Mission Control panel. No conclusion about causality or improved productivity follows from this review.

[PLAN] Bounded backend review, then integrated UI/metrics/task-detail review.
[VERIFY: ✅ 82 repository tests + 5 independent fixtures + direct source/link/search probes]
[REVIEW: independent_review; PASS for fingerprinted source]
[QUALITY: ✅ eight reproducible P2 findings closed; no remaining P1/P2 within scope]

## Current reviewed source fingerprints

Consolidated at 2026-09-08T00:10:31.414828+00:00; these 36 hashes supersede all earlier source fingerprints in this review. Combined manifest SHA-256: `7736eb8cbe39ea7b72d025f08a108aae7f85ae48cf3c5d18ecb9edda78fbea4d`. The manifest uses sorted paths and one `SHA256  path` line per file, including a final newline.

- `src/app/[[...panel]]/page.tsx`: `8da723d6275745d8ae9150032035a2cd44915f0e92ab2b589f64a4574995af87`
- `src/app/api/headquarters/knowledge/route.ts`: `0686ccc761ac7dce326aff5618e6b81f7cf4d212ff8eac8107ce62a4ce380b96`
- `src/app/api/headquarters/metrics/route.ts`: `25e26f75d3b23a7450d5b20c5e5356deacbd8d927730327eac13808f0ca370fa`
- `src/app/api/headquarters/route.ts`: `eb50f5991fd9d934bcd5eed409bc094e9db82225ef38f0670a57481c7a48b3f0`
- `src/app/api/headquarters/tasks/[id]/evidence/route.ts`: `560266b73b40179fb88987e9c29edbc4b85fc5055bf5dcba23e7e56fe2b13c8d`
- `src/app/api/headquarters/tasks/route.ts`: `a77eace65693ae022d2a001342e326892e2b2e2ddfeae2a5c3fa946ea402a02d`
- `src/components/headquarters/evidence-form.tsx`: `5acb1d9eeb362369e98f0a5e781296d16d3be278b4a56f29323600ed18483513`
- `src/components/headquarters/headquarters-panel.tsx`: `be00e8a0ce69c56f8836aa25956c30614159a438545b1e676d96c4704a1d0dcc`
- `src/components/headquarters/headquarters.module.css`: `98f28cc05d0120f8fba65fde8784ef0d4918a66e88f855a9cf40b2629a76da5d`
- `src/components/headquarters/headquarters.test.tsx`: `36fccce92f791ddbca6ee5ece029e07c3b18967231406fb89db20e5d3b8838ab`
- `src/components/headquarters/hq-data.ts`: `d5e286aaebb7d1758ad870a1e264d5c0001fbac5de85f320727b352b4c5b1e9b`
- `src/components/headquarters/hq-graph-canvas.tsx`: `ce22be1a022039168ce6cd524c4cc345f0e57b4a0163386d7274d0b88ea7d5f9`
- `src/components/headquarters/hq-graph.tsx`: `1817e9abca57b2370f37156eee7a2a8f30bd0d5df4047d177418b88bf036413d`
- `src/components/headquarters/hq-metrics.tsx`: `a40911eb8ee4d5ad633053fcb52c65e3cb008e2137d2cd027858b8385da6b6ce`
- `src/components/headquarters/index.ts`: `2cb6d41edd680138b5f6184a1410d2468db351598baf4f97c30dce7079bac11b`
- `src/components/headquarters/knowledge-inspector.tsx`: `da3fd104b7350ca3418c64a848e69312d9c042af13ca6ca94aee6e13f4f561cb`
- `src/components/headquarters/note-presentation.ts`: `4a087a2dc344af26b6b61bcf1fbe3e662c893c166d19598f655fc0e883e52892`
- `src/components/headquarters/task-composer.tsx`: `9ceb68d1073b51b6d106b33b7909108e35a93ab710e3d3753bebc3782a534acd`
- `src/components/headquarters/use-hq-resource.ts`: `71b1d14260c37f613abd4b7d9efe48fb621f1d519769b15e602e922d1ff96f53`
- `src/components/layout/nav-rail.tsx`: `52c4a38e91f7b241d6e3c1edea799609556f7effbd3499b68d6963d0632c8b28`
- `src/components/panels/task-board-panel.tsx`: `2174f5be84bb554a2cb0c8939ee80bc918cce2f38c2cd256e9c36dac6b6cf3f9`
- `src/lib/__tests__/hq-knowledge.test.ts`: `5cc5da98b03a5d3d112da284ab7ec32c463dad3465ee0f6b9edcd83d18225606`
- `src/lib/__tests__/websocket-handshake.test.tsx`: `b87afbd047df52372169798306285dab178378c0ca6e29bbd86b770527a363e2`
- `src/lib/hq-access.ts`: `e225cc005df0fc1bfa08e7d6fe33c6565cbbbf9331d77a034ec4811a8ff4457a`
- `src/lib/hq-evidence-input.ts`: `244c8a27eecf88babc5f6369bb1f71605c3e6f15a0191471c66e121b5faa78b3`
- `src/lib/hq-evidence.ts`: `bc951fb2afb1bdd176d7345f9fae65871ff9c6969c534dcf638c76d6b6135c41`
- `src/lib/hq-knowledge.ts`: `64bc113fdae910e04acbaefc09aa86ea4f92303fe3e50d4ad40718b654289245`
- `src/lib/hq-metrics.ts`: `7f5c991b7a5f3b89587a18474534c54b00b549131d67daf02e0ff5c3b494c3e4`
- `src/lib/hq-operations.test.ts`: `1d248c9ce64af67ee9a2bbf539ed7c6a9ba8358fd5f06a038712cf0966dd3b27`
- `src/lib/hq-operations.ts`: `9d4dd7f18121e6a897fc2bffee1afad6bfffe99ab6d31417149f7820237c81d1`
- `src/lib/hq-task-input.ts`: `f5d45f165bd7ea2e80ca074ff46ef92f3837dd15bdb2c5cc40a5b7a0108c340b`
- `src/lib/hq-types.ts`: `bf1d5e6e5f8218df3d2c68810f4d3c1111c0739441e18f98d8986c47bc1f19ad`
- `src/lib/navigation.ts`: `80fe93a5c8f9802f25d6072ed29e0d027045a3b9578faff7f863c371037c9db4`
- `src/lib/use-task-deep-link.ts`: `9834fca23d66947a3a7612f138459cd54452b3b8ff9c8dd46e5dae18f190602a`
- `src/lib/websocket.ts`: `82c56b27620799d444f3cfb0d23597d87fdc94994130d597601471e5d7e3db4c`
- `src/store/index.ts`: `3289e03af0874f075cf5546203305784530e0015a1b18533267ef3f3c73a02b4`

## Earlier bounded checkpoint: OpenClaw identity and cached-token compatibility

Reviewed 2026-09-07T23:48:59.906062+00:00 against the final diff in `src/lib/websocket.ts` and the two new handshake tests. **PASS: no additional P1/P2 finding.** The 32 previously reviewed source fingerprints were rechecked and remain unchanged.

- The legacy configured `control-ui` alias is trimmed/normalized once to `openclaw-control-ui`, and the same `clientId` variable is used in both the signed device payload and the outgoing `params.client.id`. Empty configuration still selects the supported default; other explicit IDs are not silently replaced.
- Cached device authentication is sent inside `params.auth.deviceToken`; the unsupported top-level `params.deviceToken` property is removed. Shared-token authentication and the token-only fallback remain intact. JSON serialization omits undefined token fields; neither token nor signed payload is logged by the changed code.
- Both new tests exercise the actual hook's emitted WebSocket frame after a challenge. The identity test also checks the ID embedded in the signed payload, so it verifies agreement across the signing/wire boundary rather than only a constant. The token test asserts the nested auth structure and absence of the former top-level field.
- The inventory agent independently validated the corrected frame against the installed OpenClaw `ConnectParamsSchema` using Ajv, including rejection controls for the legacy ID/top-level token. This reviewer relies on that primary installed-schema proof and does not claim a separate live gateway connection.

Independently executed:

```bash
pnpm exec vitest run src/lib/__tests__/websocket-handshake.test.tsx src/lib/__tests__/websocket-utils.test.ts
```

**30/30 passed (2 handshake + 28 utilities).** An environment localStorage warning did not fail the tests. No server, credential, environment or deployment mutation was performed by the reviewer. Parent retains ownership of the running-gateway/local-release proof.

The earlier WebSocket fingerprints are superseded by the consolidated current hashes above and the protocol-v4 addendum below.


## Final bounded addendum: evidence contract and protocol v4

Reviewed 2026-09-08T00:01:29.653996+00:00. **PASS: no additional P1/P2 finding.** Only the five expected previously reviewed files changed; the new `hq-evidence-input.ts` is included in the consolidated manifest. The other 29 previous file fingerprints remain unchanged. No broad re-review or runtime mutation was performed.

- **Evidence contract:** The existing strict route schema was extracted without changing its trim, minimum/maximum lengths, optional fields or unknown-key rejection. The API route and both UI save actions now use the same schema before persistence/POST. Native fields derive label 3–160, detail 3–6000 and URL 2048 limits from that schema. The UI additionally rejects non-HTTP(S) and credential-bearing URLs, matching its stated URL input contract and the server’s existing safety rule. Local validation failures do not display a misleading warning about an uncertain network write. Tests bypass native validation for both actions, verify no POST for invalid limits/URLs, and submit a payload at all maximum lengths.
- **Protocol v4:** `PROTOCOL_VERSION` changes from 3 to 4, so the existing `minProtocol` and `maxProtocol` fields both offer 4 for the operator/UI client. Identity normalization, nested cached authentication, signatures and token-only fallback are unchanged by this final delta. The new test asserts the actual emitted handshake frame’s range and operator role. Installed-version compatibility was investigated by the inventory agent; this reviewer did not independently contact the gateway.
- **Runtime evidence:** After rebuilding this v4 source, parent reports that its actual browser DOM on port 3015 displays `GW Connected` and shows no new gateway errors. That is parent-owned live browser proof, distinct from these reviewer-executed tests. Parent also reports a successful build, 137 tests across 11 files and clean scoped ESLint. Production activation and rollback remain parent-owned.

Independently executed after these final deltas:

```bash
pnpm exec vitest run src/components/headquarters/headquarters.test.tsx src/lib/__tests__/websocket-handshake.test.tsx src/lib/__tests__/websocket-utils.test.ts
```

**58/58 passed (27 UI + 3 handshake + 28 utilities).** These overlap the earlier review test runs; counts are not added as unique tests. Existing environment/tool notices did not fail any test. No new source, dependency, server, credential or environment change was made by the reviewer.


## Final source-date precision addendum

Reviewed 2026-09-08T00:10:31.414828+00:00. **PASS: no additional P1/P2 finding.** Scope is only `hq-knowledge.ts` and its knowledge-adapter regression test. Only that implementation file changed among the 35 previous fingerprints; the test file is now included in the current 36-file manifest.

The adapter previously expanded `source_date: 2026-09-08` into midnight UTC, causing the source inspector to display a time that the source never specified. `parseSourceDate` now preserves a valid calendar date as `YYYY-MM-DD`; the existing inspector formatter already displays that form without a time and with a fixed UTC calendar interpretation. Calendar round-trip validation rejects impossible dates that JavaScript would otherwise roll into another month. Only explicitly zoned timestamps are normalized to UTC; impossible clock times and timestamps without a zone are rejected. Filesystem `modifiedAt`, source content, privacy and path handling are unchanged.

The new temporary-vault fixture verifies output through the actual knowledge index, covering date-only precision, a valid leap day, invalid leap/month days, a `+02:00` timestamp, an impossible clock hour and a missing timezone. The existing Norwegian-title/source-date fixture now expects the original date precision.

Independently executed:

```bash
pnpm exec vitest run src/lib/__tests__/hq-knowledge.test.ts src/lib/__tests__/hq-knowledge-route.test.ts
```

**15/15 passed (12 adapter + 3 route).** No unrelated investigation or runtime mutation was performed. Parent reports the preceding release is active and its source → task → learning workflow is verified; building and activating this small follow-up remains parent-owned.
