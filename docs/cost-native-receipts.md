# Design note — feeding native receipts into cost observations

**Status: proposal. Nothing here is implemented.** This note exists so the next
person changing the cost surfaces starts from the actual gap rather than
rediscovering it.

## The gap, measured

Measured 2026-09-09 10:30 on this installation: 2.41 M tokens recorded for the
week, of which 3 336 (0.14 %) had a catalogue price. Every remaining token was
still assigned a dollar figure, because `getModelPricing` falls back to a
Sonnet-shaped default rate for any model it does not recognise. The panel then
rendered the sum to four decimal places.

Two different problems produced that number, and they need different fixes:

1. **Unknown prices are silently guessed.** Partly addressed on branch
   `mc-improve/ui-scope`: `hasCatalogPrice()` now separates a known price from
   the fallback, and `src/lib/cost-display.ts` withholds amounts below 50 %
   priced coverage instead of rendering a guess.
2. **The population is the wrong one.** The ledger is fed by OpenClaw cron runs.
   The native subscription workers — Claude Code and Codex — do the bulk of the
   actual work and write nothing into it. This is the part this note is about,
   and the part the display label can only warn about, not fix.

Fixing (1) makes the number honest. Only fixing (2) makes it useful.

## What the cost tabs read today

`/api/tokens` (`src/app/api/tokens/route.ts`) merges three sources:

- the `token_usage` SQLite table — `model`, `session_id`, `input_tokens`,
  `output_tokens`, `created_at` (migration `018`, plus later `agent_name`,
  `cost_usd`, `task_id`, `workspace_id` columns);
- a JSON file at `config.tokensPath`, written by the same recording path;
- gateway session snapshots via `getAllGatewaySessions()`.

`CostTrackerPanel` fans that into four tabs. All four are cuts of this one
ledger, which is why one coverage number governs all of them.

## What a native run already records

`src/lib/runs.ts` and the `runs` table (migration `049`) already carry nearly
the whole shape a cost observation needs:

| Need | Column on `runs` | Present today? |
|---|---|---|
| model | `model`, `cost_model` | yes |
| tokens in/out | `cost_input_tokens`, `cost_output_tokens` | yes |
| cache tokens | `cost_cache_read_tokens`, `cost_cache_write_tokens` | yes |
| dollar cost | `cost_usd` | column exists, usually null |
| task attribution | `task_id` | yes |
| run identity | `id`, `run_hash`, `parent_run_hash` | yes |
| provider / runtime | `provider`, `runtime`, `runtime_version` | yes |
| account | — | **missing** |

So the schema is not the blocker. Two things are.

## What is actually missing

**No account dimension.** Nothing on `runs`, `token_usage` or the JSON file
records *which subscription account* a run consumed. On this installation the
whole point of a cost view is to answer "which account is near its limit", and
`provider` alone cannot answer it: two Claude accounts are both `anthropic`.
This is the one genuinely new field.

**Native workers do not write runs.** A Claude Code or Codex session invoked
through a harness produces a transcript, not a `runs` row. Until something
converts a finished native session into a run — or into a cost observation
directly — the table stays empty for exactly the population that matters. Whether
the token counts in those transcripts are reliable enough to bill against has
**not been measured**; that measurement is the first task, before any schema
change.

## Proposed shape

A cost observation, deliberately narrower than a run:

```ts
interface CostObservation {
  source: 'openclaw-cron' | 'claude-code' | 'codex'   // never inferred, always stated
  account_ref: string        // opaque installation-local label, e.g. 'anthropic:primary'
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number | null
  cache_write_tokens?: number | null
  price_basis: 'catalogue' | 'reported' | 'unpriced'  // never 'default fallback'
  cost_usd?: number | null   // null when price_basis is 'unpriced'
  task_id?: number | null
  run_id?: string | null
  observed_at: number
}
```

`price_basis` is the load-bearing field. It is what lets a query say "84 % of
this week's tokens were unpriced" instead of producing a total that reads as
measured. `account_ref` must be an installation-local label, never a token,
email or account id — the cost surface is rendered in a browser.

## Files that would change

| File | Change |
|---|---|
| `src/lib/migrations.ts` | new migration: `cost_observations` table, or `source` + `account_ref` + `price_basis` columns on `token_usage` |
| `src/lib/token-pricing.ts` | `hasCatalogPrice()` already lands on `mc-improve/ui-scope`; add a `priceBasis()` that returns the enum rather than a boolean |
| `src/app/api/tokens/route.ts` | read observations alongside `token_usage`; `coverage.pricedTokenPercent` (already returned, from `src/lib/token-ledger.ts`) gains the native sources instead of covering only the cron ledger |
| `src/lib/cost-display.ts` | **done** — `resolveDisplayCoverage()` already prefers the server's `coverage.pricedTokenPercent` and keeps the model-breakdown derivation as the fallback |
| `src/components/panels/cost-tracker-panel.tsx` | scope label narrows per source instead of the blanket "cron tokens only" |
| new ingest module | converts a finished native session into observations |

## Order of work

1. **Measure first.** Take a sample of finished Claude Code and Codex sessions
   and check whether a token count can be recovered per session at all, and how
   it compares to the provider's own reporting. If it cannot, the rest is moot
   and the scope label stays as the honest answer.
2. **Done, in part.** `/api/tokens` already returns the priced/total split as
   `coverage.pricedTokenPercent`, and the display gate now reads it via
   `resolveDisplayCoverage()` instead of deriving coverage client-side. What
   remains of this step is `price_basis` itself — a name for a distinction the
   code already makes, but does not yet record per record.
3. Only then add `source` and `account_ref` and an ingest path.

Step 3 is not worth starting until step 1 answers yes. Note that finishing
step 2 does **not** improve the measured number on its own: the server's
coverage is computed over the same cron ledger, so it reports the same ~0.1 %
until step 1 and step 3 give it something else to count. The gain is that there
is one definition of coverage instead of two.

## What must not happen

- Do not fill `cost_usd` for a native subscription run from a catalogue rate. A
  subscription seat is a fixed monthly cost; multiplying its tokens by an API
  list price invents spend that nobody was billed. `price_basis: 'unpriced'` is
  the correct value there, and a token count is the honest metric.
- Do not remove the scope label once native sources land. Narrow it to name the
  sources actually present, so a gap in one source stays visible.
- Do not put an account identifier, key or email in `account_ref`.
