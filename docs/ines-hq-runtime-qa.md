# Ines HQ runtime QA — 2026-09-08

## Verified in the running application

The authenticated headquarters is active at `http://127.0.0.1:3005/` under the existing `ai.mission-control` LaunchAgent. The initial implementation commit on the operational branch is `07458d6` (isolated implementation commit `cb849e4`). Initial released build: `ActlA9Qi64zFJH_mGLe3x`.

- Chrome desktop: overview, project selection, 2D and actual WebGL 3D graph, source inspector, search, decisions and analysis were inspected and operated. Original note text is readable, frontmatter is hidden only for presentation, and confirmed source relationships are actionable.
- The first browser-created task was written to a consistent preview copy of the MC database. Opening it through HQ navigated to the existing task board and displayed its detail modal even though it was outside the board's current list page.
- Production browser flow created **TASK-1031 / task 1295**, “Evaluer nytten av Ines-hovedkvarteret etter første driftsuke,” with the Nate research note as source, three acceptance criteria and a stated outcome. The existing MC triage subsequently assigned it to Stella and moved it to `awaiting_owner`; HQ evidence recording did not cause that transition.
- Browser evidence registration on task 1295 wrote a real vault learning: `04-resources/learnings/deep-learn/2026-09-08-hq-task-1295-1d3147120a.md`. The browser's “Åpne læringen i vault” action read that note back and showed both its original research reference and incoming task → learning connection. The API returned one evidence item, one original source ID and one separate learning ID.
- Authenticated HQ, knowledge search, project metrics and task detail returned HTTP 200. Unauthenticated HQ returned HTTP 401. Workspace/tenant and write-role boundaries were independently fixture-tested.
- The rebuilt browser reported **GW Connected** after correcting legacy client ID, cached-token location and the operator protocol version required by installed OpenClaw. Exact loopback production origins were added while preserving existing origins and authentication policy.

## Retrieval and metrics

Ten keyword/source pairs were declared before running the checks, all after implementation. All ten retrieved the expected allowed source; eight ranked first, one second and one third. Nine used QMD, one used the explicit local full-text fallback. Median query time was 0.175 seconds. All returned scopes matched the selected project plus shared knowledge. This is a bounded retrieval smoke test, not a semantic-answer evaluation, pre-implementation baseline or productivity study.

At 00:06 UTC, the production knowledge index held 1,140 notes and 154 confirmed note links; the task view contained the prioritized maximum of 200 tasks. Counts are dated observations and change as the vault and MC are updated.

The authenticated production PostHog adapter returned Babysential aggregates for 2026-08-09–2026-09-07 UTC: 500 pageviews, 301 distinct browser IDs, one `newsletter_opt_in` event and 0.85% in the bounded popup → opt-in cohort. The cohort card remains `needs_review` because the previous saved funnel used a different completion event. BabyHub metrics returned null/unavailable, not fake zero. No personal event rows were retrieved.

## Build, review and operational checks

The initial release passed 137 targeted repository tests across 11 files, complete production compilation/TypeScript, scoped ESLint and independent review. The reviewer also executed independent temporary-vault/SQLite and stale-UI reproductions. Overlapping review runs are not added as unique tests. Source review fingerprints are recorded in `ines-hq-review.md`.

Release files and rollback evidence are retained locally in `~/tmp/ines-hq-release-20260908/`. The first immediate launchd bootstrap attempt met asynchronous unload timing; the old build was restored and verified serving HTTP 200. A bounded bootstrap retry then activated the staged build successfully. No database restore was needed, and no HQ database migration was introduced. Existing independently owned scheduler/dispatch/event/startup edits were preserved byte-for-byte during integration.

## Verification limits

- A separate narrow/mobile viewport capture was unavailable: the dedicated Playwright connector returned `Transport closed`, native Chrome window control returned `cgWindowNotFound`, and a window query did not complete and was cancelled. Desktop behavior, responsive container CSS and component tests were checked; there is no claim of completed mobile-browser acceptance. The earlier static concept's mobile QA is a different artifact.
- Desktop 3D rendered successfully. Large-graph capacity beyond the bounded 40-node neighborhood and every browser/GPU combination were not benchmarked.
- Source dates are evidence metadata, file modification is filesystem freshness, and neither proves continuing factual accuracy. The production loop exposed a date-only precision issue; its targeted correction and final readback are recorded in the delivery addendum.
- PostHog is the implemented product adapter for Babysential. GSC, BabyHub analytics, social and financial providers were inventoried but are not newly connected in HQ. Existing MC operational panels remain available.
- Restricted Skool coursework and Nate's private backend were not accessed. The public package, source ledger, transcript and selected demo visuals have separate explicit coverage records in the vault report.
- The usage follow-up is real future work. No claimed productivity increase, semantic graph distance or causal product lift follows from the successful technical release.
