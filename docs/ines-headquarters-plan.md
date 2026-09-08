# Ines headquarters implementation — 2026-09-08

User explicitly requested a working headquarters adapted from Nate Herk's AI OS, with full local access and no further approval prompts. Research, skill improvements and source inspection are retained. Implementation and local deployment are now authorized. External messages and public sharing are not part of this task.

Isolated branch: codex/ines-hq-20260908. Existing edits to start-standalone, event-bus, scheduler and task-dispatch are copied into the worktree and remain separately owned.

### Task 1: Source research and implementation contracts [done]
- depends_on: []
- blocks: [2, 3, 4]
- priority: high
- [x] Read complete video transcript, selected visual demos, six skills and custom source.
- [x] Verify 96 source blobs and 40 mirrors; run upstream fixture with 188 notes.
- [x] Define HQ types, role/workspace boundary and bounded project sources.
- [x] Preserve existing dirty changes in isolated worktree.

### Task 2: Knowledge and source graph adapter [done]
- depends_on: [1]
- blocks: [5]
- priority: high
- Owner: local_inventory — hq-knowledge library, knowledge route and tests.
- [x] Index bounded canonical project/concept/research notes with stable identity, Unicode links and source dates.
- [x] Add QMD with explicit local full-text fallback.
- [x] Verify path, scope, link and search cases.

### Task 3: Live metrics adapter [done]
- depends_on: [1]
- blocks: [5]
- priority: high
- Owner: source_research — hq-metrics library, metrics route and tests.
- [x] Connect bounded aggregate PostHog queries for Babysential, with dates and definitions.
- [x] Represent unavailable providers honestly; no secrets or personal event rows.
- [x] Verify cache, timeout, error and real readback.

### Task 4: Headquarters interface [done]
- depends_on: [1]
- blocks: [5]
- priority: high
- Owner: skill_upgrade — src/components/headquarters only.
- [x] Ship project overview, knowledge graph/detail/search, decisions/tasks and analysis.
- [x] Real task proposal submission with idempotency and explicit source context.
- [x] Responsive, keyboard-accessible states and meaningful tests.

### Task 5: Operational integration and evidence loop [done]
- depends_on: [2, 3, 4]
- blocks: [6]
- priority: high
- Owner: parent — snapshot, task persistence, navigation, deployment and source configuration.
- [x] Join real scoped MC projects/tasks/agents/activity with source identities.
- [x] Persist a selected task without duplicating work or triggering external publication.
- [x] Carry criteria, evidence and measured/unmeasured state across the existing task flow.
- [x] Integrate into primary MC navigation and retain existing operational panels.

### Task 6: Independent review, runtime QA and local release [in-progress]
- depends_on: [5]
- blocks: []
- priority: high
- Owner: independent reviewer + parent.
- [x] Targeted tests, TypeScript, lint/build, independent review. 132 repository tests pass (82 HQ + 50 gateway/auth/config); independent fixtures pass; Next production build passes.
- [ ] Test real data, source opening/search, task persistence/deduplication and metrics.
- [ ] Browser QA on desktop/mobile and authenticated access.
- [ ] Activate local MC build with backup/rollback and verify running version.
- [ ] Archive research and sync final operational facts to vault.
