# Mission Control feature-surface audit — 2026-09-08

Scope: the existing local MC at `127.0.0.1:3005`, source checkout in the `surfaces` worktree, and read-only OpenClaw gateway calls. The parent workstream owns production deployment, browser verification, HQ/projects, agent models, and runtime coordination. The user-facing browser was not controlled by this workstream.

The pre-deployment API probes are recorded in `2026-09-08-surface-probes.json`. They contain response shapes, counts, and durations only; no passwords, prompts, token values, message content, or raw configuration. A successful read is not evidence that every mutation or external integration works.

| Surface | Verification / actual observation | Status and action |
|---|---|---|
| Overview | `/api/status` 200, runtime/memory/disk/process response. Route mapping inspected. | Read verified; widget actions and visual states belong to parent browser QA. |
| HQ, project rooms, Tasks | Source route ownership identified. | Separate HQ/project workstream; not duplicated here. |
| Agents, Chat, Sessions, Workflows/Pipelines | Separate runtime/coordination workstream owns dispatch and results. | Not claimed verified by this report. |
| Channels | `/api/channels` 200, `connected: true`, one channel in ordering. | Read verified. Did not send messages, link accounts, or log out. |
| Skills | `/api/skills` 200, 207 skills in six groups. | Read verified. Registry/install/update actions not exercised. |
| Memory | `/api/memory?action=tree&depth=1` 200, one allowed root; prefix/path guard source reviewed. | Tree read verified. No personal note content requested and no note edited through this API. |
| Activity | `/api/activities?limit=5` 200, five records and `hasMore: true`. | Read verified; filters/pagination source inspected, not exhaustive browser testing. |
| Logs | `/api/logs?action=recent&limit=5` 200, five records. | Read verified; logs' contents not copied into report. |
| Cost Tracker | Pre-fix day summary: 59 records, 1,664,574 tokens, $5.723694 estimate; seven models. Task attribution and DB-only agent breakdown both empty. | Fixed bogus savings, workspace isolation/storage, and source reconciliation. Overview and agent detail now share one response and ledger. Exact reported identity wins over snapshots; unknown actors stay unattributed. Price/source coverage and excluded overlaps are visible. Session details and full-period trends are implemented; missing/deleted task mappings remain unattributed instead of disappearing. See accounting limits below. |
| Nodes | Pre-fix endpoint returned 200/empty/connected after ~12 seconds even when RPC errors could be swallowed. Direct `node.list` later proved a healthy empty list. `device.pair.list` returned five paired devices and no pending requests. | Fixed error suppression and discarded `paired`/`pending` response fields. UI now shows retrieval errors, last-seen timestamp and unknown trust honestly. Pairing/token mutations not executed. |
| Approvals | Initial HTTP endpoint returned empty by swallowing failure. After OpenClaw update, direct `exec.approval.list` returned a valid empty list. | Fixed source to real RPC; panel reloads pending queue. Panel and overlay now require actual `ok:true` acknowledgment before updating status. Failure leaves the request pending. No real request approved/denied and allowlists untouched. |
| Office | Source uses `/api/agents`, local sessions, browser layout preferences and explicit flight-deck actions. | Source inspected. Agent/session data checked by runtime workstream; room/keyboard interactions not exercised here. |
| Monitor | `/api/system-monitor` 200, CPU/memory/disk/network/process groups, one disk, eight process records. | Read verified. Does not establish historical trend accuracy. |
| Cron | MC returned zero jobs; direct gateway first page had 200 of 223 jobs (`hasMore` and `nextOffset:200`). | Replaced obsolete jobs.json/runs.json reads and file mutations with paginated gateway list/history and acknowledged add/update/remove/run. No production jobs modified. Calendar respects enabled state, timezone, anchored intervals and one-shots. Copies are disabled; duplicate names never replace jobs. |
| Webhooks | `/api/webhooks` 200, zero endpoints. | Unconfigured. Did not create endpoints, deliver tests, or retry outbound messages. |
| Alerts | `/api/alerts` 200, zero rules. | Unconfigured. No invented alert rules or test notifications. |
| GitHub | `/api/github?action=stats` 400, explicit `GITHUB_TOKEN not configured`. Initial `action=status` GET was invalid; source confirms status uses POST and stats uses GET. | MC integration unconfigured. A separate `gh` login does not itself prove MC token availability. No comments/issues/sync writes executed. |
| Security | `/api/security-audit` 200 with posture, scan, auth events, trust, exposure and audit summaries. | Summary read verified; not a clean security verdict or fresh full scan. Fix/security actions not executed. |
| Users | `/api/auth/users` 200, one account; role/workspace guards inspected. | Read verified. No user/password/token changes. |
| Audit | `/api/audit?limit=5` 200, five events and pagination metadata. | Read verified; not a proof that every action emits complete audit events. |
| Gateways | `/api/gateways` 200, one configured gateway. Direct read-only RPCs returned valid data. | Read verified. Runtime update and restart owned by parent/OpenClaw workstream. |
| Gateway Config | Navigation and API source inspected. | Read/source inspection only. No configuration mutation by this workstream. |
| Integrations | `/api/integrations` 200, 16 entries/9 categories; status counts: four `connected`, twelve `not_configured`; `opAvailable:false`. | Four credentials/configurations detected; not four successful provider tests. No credential output or integration tests with side effects. |
| Debug | `/api/debug?action=status` 200, `ok:true`, `gatewayReachable:true`. | Basic read verified. Arbitrary calls and repairs not executed. |
| Settings | `/api/settings` 200, 26 settings. | Read verified. Existing trigger gate retained; no backup restore/reset/credential rotation performed. |

## Fix verification

Initial delivery focused suite: **137 tests passed across 14 files**, followed by a successful TypeScript check and clean targeted lint. After the final stable-sort/effect cleanup, the two affected suites passed again (9 tests). The existing Playwright cron contract now distinguishes unavailable from empty; it was updated but not run in this workstream.

- Gateway contract tests cover pagination >200, non-advancing pagination, malformed data, status mapping, command/interval/one-shot schedules, history timestamps, disabled clones, duplicate protection and desired enabled state.
- Cron parser correction was implemented through a real scoped Claude Code → GLM 5.3 session, then independently reviewed. Reviewer added safe-integer step validation and a regression test; parser suite has 47 tests. The full change uses no provider-price estimates as billing evidence.
- Calendar tests verify UTC against browser-local time, DST date handling, Sunday alias 7, numeric-start steps, enabled-state exclusion and anchored intervals.
- Cost tests reject zero/unknown/negative/non-finite comparison winners; storage tests prove other workspace retention, concurrent writes and preservation of corrupt stores on error.
- Token route tests prove secondary workspaces cannot read the primary global session store and that real session identifiers are retained.
- Approval tests exercise deferred receipts and rejection without resolving any real approval.
- Nodes tests distinguish healthy-empty from unavailable and preserve paired/pending data.
- TypeScript check and targeted lint run in the isolated worktree. Corrected the pre-existing overlay effect dependency warning while editing it; no lint errors remain.
- Production build, live browser checks and release are deliberately left to parent integration. No blanket claim that all functions are fully tested.

Cost follow-up validation: **51 tests passed across eight files**, with successful TypeScript check and clean targeted lint.

The cost follow-up uses one workspace-scoped loader for database usage, manual records and physical session snapshots. Its focused tests cover identical overview/agent/model totals, explicit unattributed usage, session alias deduplication, ambiguous overlap exclusion, time filtering before source selection, missing sources, reported versus unknown dollars, small-cost precision, real session details, weekly trends and missing task metadata. No production records were backfilled or reallocated. Unknown models receive no default tariff; a subscription flag is not evidence that a particular API call was free.

## Remaining limitations and concrete follow-ups

1. **Cost accounting**: the shared ledger is a conservative usage estimate, not an invoice. Snapshots are cumulative session observations selected by last activity, not period deltas. Database observations take precedence over manual observations for the same session/model; exact or potentially ambiguous overlaps suppress snapshots, with exclusion counts exposed. This can undercount when sources cannot be reconciled safely. Explicit `cost_usd` is reported cost; otherwise only an exact catalogue match is estimated. Unknown prices remain excluded from dollars and visible in coverage. Claude and Grok basis tariffs were verified against official documentation on 2026-09-08; other catalogue tariffs retain their previous provenance and the existing DB read is capped at 10,000 rows. Provider billing and snapshot deltas require separate provenance before financial reliance.
2. **Attribution**: all cost views now share the same source set; the agent view is no longer DB-only. Task/opaque session IDs do not become invented agent names. Missing/deleted/inaccessible task mappings remain in unattributed totals. Historic task IDs cannot be recovered without evidence. Source-read errors are exposed where observable; the existing session reader can still suppress underlying filesystem errors.
3. **Advanced schedules**: the calendar fully expands numeric five-field cron, anchored `every`, and `at`. Gateway six-field/named-field/event-trigger schedules remain listable but are not fully forecast by this calendar; their next actual gateway timestamp is shown when available. Execution semantics remain with OpenClaw.
4. **Integration readiness**: GitHub, twelve integration entries, webhooks and alerts need purposeful configuration. Empty configuration is not a defect to conceal with demo data.
5. **Approval decision policy**: OpenClaw can reject `allow-always` according to the request's policy. The UI now preserves and reports failure; it does not relax gateway approval rules. Approval list visibility also follows the authenticated gateway client identity.
6. **Manual run gate**: `MISSION_CONTROL_ALLOW_COMMAND_TRIGGER=1` remains required. This audit does not enable it or run pre-existing automation jobs; source and mocked contract tests verify the dispatch route.
7. **Storage**: manual usage writes are serialized within the MC process and atomically replaced. Concurrent writers from a different process to the same JSON file are not supported; consolidate into SQLite if that becomes necessary.

## MC skill gotchas for parent to promote

- OpenClaw 2026.7+ persists cron definitions beyond jobs.json; use gateway cron RPC or CLI, and follow `hasMore/nextOffset` (200 maximum per page).
- Gateway run request acceptance is not execution success; inspect run history and actual artifacts. Disabled clones prevent accidental duplicate automations.
- `device.pair.list` returns `paired` and `pending`; `node.list` is a separate list of execution nodes. A paired UI/CLI device is not an execution node.
- `exec.approval.list`/`resolve` are gateway RPCs. Successful WebSocket `send()` does not confirm approval resolution.
- Cost overview and agent detail share one ledger and response. Physical session aliases are deduplicated; ambiguous overlaps are omitted and counted. Unknown models have no default tariff, and possession of a subscription does not establish the billing route. Snapshots describe session counters, not invoices or period deltas. 0% task attribution means task IDs are missing, not that tasks were free.
- A GitHub CLI session is distinct from the MC `GITHUB_TOKEN` integration.

## Final parent integration and live verification

The integrated code release `beb2ace1d65f50ec615f19be4807f1e69334ffbd` was deployed on 2026-09-08 after **1,305 passing tests in 123 files**, TypeScript, full ESLint, API contract parity and a successful production build. A staging copy first verified boot, authentication and static assets; the final live bundle passed login/asset probes too.

The parent navigated the sidebar surfaces and verified the key interactive paths: project selection and persisted team roles; all 223 cron jobs; nodes versus five paired devices; identical cost overview/agent totals with Unknown/partial/priced-zero distinctions across detail tabs; current managed update/hold notices after cache bypass; and the completed Grok research report with safe clickable sources. Native Memory's empty graph is legitimate here and now explicitly distinguishes its missing SQLite indexes from working file-backed memory and HQ's vault graph. Empty or still-loading UI snapshots were not treated as proof that data was absent.

Real execution tests completed through MC→OpenClaw→local Ollama and through MC→Grok Build 4.6. A separate native local heartbeat returned heartbeat_respond(no_change, HEARTBEAT_OK, notify=false) without external delivery. All original 223 cron definitions and existing heartbeat intervals/targets were preserved. OpenClaw 2026.7.1-2 is live; 2026.9.2 remains held for migration/compatibility concerns.

Pricing follow-up retained coverage in Sessions/Tasks as well as Overview/Agents. The user report explains that only about 0.2% of the day's observed tokens had a known price at verification time; the remainder is excluded from dollars, not assigned zero. Task attribution counts real linked usage records. Claude/Grok base tariffs were verified on the audit date.

See the local vault report `2026-09-08-mission-control-operativt-hovedkvarter.md` and the protected run directory `/Users/inesskogbrynet/tmp/mc-optimization-20260908/` for release receipts, model evidence and verified compressed rollback archives. Existing source changes were preserved; no upstream push, unrelated task replay or blanket external integration activation was performed.
