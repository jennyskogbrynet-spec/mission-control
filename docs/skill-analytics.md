# Local skill analytics

The Skills panel's **Statistikk** tab reads a version1 aggregate snapshot from
`config.dataDir/skill-analytics.json` (normally `.data/skill-analytics.json`).
`MC_SKILL_ANALYTICS_SNAPSHOT` may override that one server-owned file. There is no
home-directory scan, database migration, transcript ingestion or write endpoint.

The authenticated viewer route `/api/skills/analytics` permits only the primary
workspace1, independently of the snapshot's `workspaceId`, and verifies that
binding again. Other workspaces receive an unavailable state. Responses are
private/no-store and contain only schema-whitelisted aggregate fields. Import
inputs remain private; paths, contents and transcript evidence are omitted.

Import approved collector outputs atomically (output permissions0600):

```sh
python3 scripts/import-skill-analytics.py \
  --inventory /approved/inventory/inventory.json \
  --usage /approved/usage/usage.json \
  --output /configured/private/data/skill-analytics.json
```

Omit `--usage` for an inventory-only snapshot with unknown observations. The
adapter joins exact canonical skill IDs, never names. Empty native coverage also
produces unknown values even if zero-filled aggregate rows exist. Native coverage
is always described as partial: transcripts, compressed files, skipped privacy
roots and historical windows may be incomplete. Covered zero is an absence of
documented observations, never proof the skill was unused.

Day/session values summarize documented native invocations and submitted attempted
targeted document reads and script commands. Wrapped-command attempts have medium
syntactic evidence and do not prove the nested call executed. Direct invocation
and wrapped-attempt counts overlap the read/script categories and must not be
added together. Hook and cumulative loader counts are supplemental and excluded
from day/session totals; missing supplemental coverage leaves those categories
unknown rather than manufacturing zero. Completed tool calls describe
the tool's outcome, not skill effectiveness. No monetary savings, quality score
or token total is inferred. Entrypoint words/bytes are context-size proxies only.
Inventory status `enabled_config` proves a plugin ID was enabled, not that a
particular cached version was active. Heuristic flags and retirement proposals
require manual assessment of relevance and dependencies.

Search matches skill name, origin/status, category, flag and proposal. Column
buttons toggle ascending/descending ordering; unknowns remain last. CSV exports
the visible sorted rows and neutralizes spreadsheet formulas. Empty inventory,
no matches, missing snapshot, malformed snapshot and transport error have
distinct user states. Refresh rereads the snapshot without changing collector
inputs or triggering automation.

Shared validation schema: `src/lib/skill-analytics-schema.json`, consumed by both
the TypeScript reader and the Node validator used by Python
`validate_snapshot(snapshot)`. That function returns validated data or raises
sanitized ValueError, and must be called again after proposal enrichment and
before publication. It requires the existing MC Node runtime and dependencies.
IDs are unique, count values are nonnegative integers (not booleans), public
labels cannot contain slash/backslash paths, and diagnostic flags are safe codes.
The10MB limit is checked before publishing and reading. Invalid imports preserve
the prior output. Missing snapshot is `unavailable`; malformed/schema/oversized
data is `invalid`; read failures are `error`, with no raw path/error diagnostics.

Type interfaces: `src/lib/skill-analytics-types.ts`; validation/privacy reader:
`src/lib/skill-analytics.ts`. Focused verification:

```sh
python3 -m unittest scripts/test_import_skill_analytics.py
pnpm exec vitest run src/lib/__tests__/skill-analytics.test.ts src/app/api/skills/analytics/route.test.ts
pnpm typecheck
```
