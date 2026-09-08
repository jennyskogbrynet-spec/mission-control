# Ines headquarters operations

The headquarters is the default Mission Control page at `/`; `/headquarters` is also valid. The classic dashboard is `/overview`, and the existing task board, agents, chat and other operational panels remain available. It extends the existing application and SQLite task database; it does not establish another task system.

## Daily use

1. Select BabyHub, Babysential, brRRR or shared knowledge.
2. Search for a source, inspect its original content/date and follow confirmed relationships. The 2D, 3D and list views show the same source identities; visual proximity has no semantic meaning.
3. Create a task with source references, acceptance criteria and expected outcome. An uncertain request can be retried without duplicating the task. Open the task in the existing MC board for assignment and execution.
4. Select a task in HQ to register observed evidence. Saving learning writes an immutable result note to the existing vault and links task → learning, while preserving the original source → task relationship. Evidence alone does not complete a task or establish product impact.
5. Use Analyse for dated aggregate metrics, source definitions and availability. Compare measurements only when periods and event definitions agree.

## Data and boundaries

- Authenticated existing MC roles apply. Reads require viewer; writes require operator. Workspace and tenant must match server-side `HQ_WORKSPACE_ID` / `HQ_TENANT_ID` (default 1).
- Vault roots: `02-projects/babyhub`, `02-projects/babysential`, `02-projects/brrrr`, `03-areas/concepts`, `04-resources/learnings/deep-learn`. Private/secret/raw asset paths and symlinks are excluded. This is a bounded project index, not complete access to every family file.
- Default vault: `~/.openclaw/workspace/vault`; optional server override `HQ_VAULT_ROOT`. Limits: 2,000 notes, 20,000 confirmed links, 32 MB total text, 256 KB per file. Coverage and omissions are displayed.
- QMD uses the installed local CLI with a short timeout and checks every result against the allowed index. Local full-text fallback is explicit. No new embedding service or hosted LLM is needed for HQ retrieval.
- MC includes at most 200 prioritized tasks from recognized active projects and explicitly HQ-created shared tasks. Summary counts refer to this selection, not all historical tasks. Existing resolutions and run provenance are visible evidence, not automatic measured outcomes.
- PostHog is connected for Babysential only: server-side `HQ_POSTHOG_API_KEY`, `HQ_POSTHOG_PROJECT_ID=382457`, `HQ_POSTHOG_HOST=https://us.posthog.com`. The client never receives the credential. Queries return aggregates, not personal event rows. Fixed host allowlist and bounded cache/timeouts apply.
- The current newsletter metric uses `newsletter_opt_in`. An older saved funnel uses `newsletter_subscribed`; the conversion card explicitly requires review before trend comparisons. ID counts are tracking IDs, not verified people. Other product/analytics providers display unavailable rather than invented zeros.

## Refresh and storage

HQ refreshes every minute while visible, without overlapping requests. Knowledge has a 30-second cache; successful evidence writes invalidate it. PostHog uses five-minute caching. Failed refreshes retain original timestamps and label old metrics unconfirmed.

Task mutations use the existing tasks/projects/activities tables. No HQ schema migrations were added. Learning writes use exclusive file creation and content checks; manual edits are never overwritten on retries. No automatic external message, publication or deployment is triggered by the HQ task form.

## Build and release

The implementation was isolated in `.worktrees/ines-hq-20260908`, preserving four pre-existing edits to startup, scheduler, event bus and task dispatch. `pnpm build` creates the normal Next standalone artifact. Preserve pnpm symlinks when staging it; remove copied `.env*` files from the staged standalone directory before activation. Preview database paths and `MISSION_CONTROL_TEST_MODE=1` must never become production defaults.

The existing `ai.mission-control` LaunchAgent starts `scripts/start-standalone.sh` on port 3005 and reads the main repository's `.env` for server settings. Release evidence and rollback files are local in `~/tmp/ines-hq-release-20260908/`: the original environment, plist, consistent SQLite backup, previous `.next`, and activation proof. These files include private operational data and must remain local.

Rollback code/build without restoring the database: stop the LaunchAgent, preserve the failed `.next`, put `next-before` back at the repository's `.next`, restore `.env.before`, then bootstrap the original plist. HQ uses existing tables, so a normal code rollback preserves newly recorded tasks and evidence. Restore the database only for a separately established data failure.

## Validation records

See `ines-hq-review.md`, `ines-headquarters-plan.md`, and the final vault research report. Runtime proof distinguishes authenticated API responses, browser flows, read-only provider observations and actual deployment. Retrieval probes are post-implementation smoke tests; they are not a before/after productivity study. A later usage pilot should measure successful retrieval, time to a useful action and whether recorded learning informs subsequent work.
