# Mission Control development and operations

Mission Control is the local operational headquarters for projects, knowledge, agent work and evidence. Keep product flows plain and understandable. Prefer the existing TypeScript/Next.js, SQLite and component patterns.

## Work ownership

Preserve pre-existing changes. Delegate concrete independent file scopes when the user authorizes it; tell each worker they share the codebase and must not revert others. Use isolated worktrees and one integration owner. Commit only your own changes. Do not run several full builds or dependency installs at once on the Mac Mini.

Use current conversation authorization. Do not ask again for already authorized internal edits, tests, service restarts or configuration changes. Do not send messages to people without explicit authorization. Never expose credentials in logs, UI, commits or reports.

## Data and state

- Live project and agent registries are authoritative; do not hardcode IDs, counts, names, model versions or deadlines in operational UI.
- Every database read/write must be scoped to the authenticated workspace. The local OpenClaw gateway is shared infrastructure owned by the primary workspace; fail closed for other workspaces.
- Project team membership is metadata, not an instruction to start a run.
- HQ may index only explicitly approved knowledge roots. A new project must start with an honest empty state, not broad home-directory access.
- Preserve task claims, idempotency keys, dispatch budgets, run IDs and evidence. Never automatically retry an uncertain external dispatch.
- Treat configured, available, authenticated, accepted and completed as distinct states. A green health endpoint is not proof that the scheduler, model or delivery path works.
- Use gateway cron RPC and complete pagination. Do not modify legacy OpenClaw jobs.json or assume 200 is the total.
- Cost estimates need coverage and attribution context. Unknown prices or zero-token rows never prove savings.

## Code map

- HQ/project rooms and scoped knowledge: src/components/headquarters, src/lib/headquarters, src/app/api/headquarters, src/app/api/projects.
- Agent registry/transport: src/lib/agent-sync.ts, src/lib/agent-delivery.ts, src/lib/openclaw-gateway.ts, src/app/api/agents.
- Task lifecycle and dispatch safeguards: src/lib/task-dispatch.ts, src/lib/scheduler.ts, src/app/api/tasks.
- Grok Build research: src/lib/grok-research.ts and src/app/api/agent-runtimes/grok/research.
- Auth/workspaces: src/lib/auth.ts, route guards and SQLite workspace_id filters.
- Feature coverage and operational limits: docs/audits and docs/mc-coordination-grok-research.md.

## Verification and release

Run meaningful focused tests for changed behavior, then typecheck and applicable lint. Reviewer findings need concrete evidence; fix high-impact findings before release. For browser QA, use the authorized UI tools and verify actual interactions. Empty data and missing integrations must remain distinguishable from errors.

Build with an isolated data directory, scheduler disabled and no production credentials. Preserve a known-good standalone bundle before switching the managed service. The generic deploy-standalone.sh fetches/merges and stops production before building; inspect it before use. Never reseed a healthy database on restart. Verify authenticated API health, static assets, project scope and a bounded synthetic command after deploying.

Use the canonical mission-control skill at /Users/inesskogbrynet/.openclaw/workspace/skills/mission-control/SKILL.md for current operational details. Use openclaw-update for gateway upgrades; one owner must complete verified backups and rollback readiness before package changes. Document measured gotchas and synchronize durable outcomes to the local vault without secrets.
