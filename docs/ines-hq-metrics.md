# InesHQ business metrics

`GET /api/headquarters/metrics?project=babysential` returns four aggregate measurements from Babysential's PostHog project. `requireHQAccess` runs before configuration or provider access and applies the headquarters workspace/tenant boundary. Responses use `Cache-Control: private, no-store`.

Valid project keys are `babyhub`, `babysential`, `brrrr`, and `shared`. Omitting the filter returns all projects. Only Babysential has a configured business source; the other projects return explicitly unavailable measurements with `null` values and their own source explanation. Babysential data is never reused for another project. Agent costs and operational status are separate from these measurements.

## Configuration

Set these variables in the Mission Control server environment:

```text
HQ_POSTHOG_API_KEY=<personal API key with Query Read access>
HQ_POSTHOG_PROJECT_ID=382457
HQ_POSTHOG_HOST=https://us.posthog.com
```

Project **382457 belongs to Babysential**, not BabyHub. The adapter accepts only the official US/EU PostHog origins, numeric project IDs, and a nonempty server key. It refuses redirects. Credentials remain in the server request header; the browser receives neither keys nor raw provider responses. The adapter does not read the OpenClaw environment file, modify saved insights, or write provider data. Card source links open the PostHog project; they are not saved-report or query-result permalinks. The exact measurement is computed by this adapter.

## Measurement definitions

The common observation window is the last **30 completed UTC days**, excluding the current partial day. Each card includes the exact dates and source refresh time. UTC dates can differ from the local Oslo date near midnight.

| Measurement | Definition | Interpretation |
| --- | --- | --- |
| Sidevisninger | Count of `$pageview` events during the window. | Event count; tracking and consent affect coverage. |
| Aktive nettleser-ID-er | Distinct `distinct_id` values with at least one `$pageview`. | Tracking IDs, not a verified number of people or PostHog's merged-person count. |
| Nyhetsbrev: opt-in-hendelser | Count of `newsletter_opt_in` events. | Events, not verified email subscriptions or deliveries. Repeat events can count more than once. |
| Popup → opt-in | Percentage of eligible tracking IDs with an opt-in within 24 hours after their first `popup_shown` in the window. | One first-popup cohort per tracking ID; no cross-device identity merge. IDs whose first popup falls in the last observation day are excluded, giving every included ID a full 24-hour conversion opportunity. |

The ratio's numerator and denominator are returned as two labeled `steps`. The denominator is therefore a 29-day first-popup cohort inside the 30-day observation period. An ID qualifies once; an opt-in before its first popup does not qualify. An opt-in exactly 24 hours later qualifies. The query counts at second precision. No denominator means `null`, not a fabricated 0%.

The existing saved newsletter funnel uses `newsletter_subscribed`, while this adapter uses `newsletter_opt_in`. The fourth card is always `needs_review` and displays this definition difference plus the observed legacy-event count. This is an explicit definition review flag, not proof that the historical report is broken. The previous saved result of 125 → 0 covered August 8–September 7 and is **not** used as live data or a fallback. Do not compare these two funnel series until the event implementation and identity/window definitions are reconciled.

## Retrieval, freshness, and failure behavior

- One time-bounded HogQL query groups the four relevant event names by tracking ID inside PostHog, then returns exactly six nonnegative integer aggregates. No person list, identifiers, properties, raw events, or query rows containing personal information leave the provider.
- Outer aggregates use distinct, qualified aliases. A real initial probe exposed ClickHouse's alias-substitution `illegal_aggregation` behavior; `sum(browser_events.pageviews) AS total_pageviews` avoids the collision with the input `pageviews` column.
- Successful requests share a five-minute process-local cache and in-flight request. Cache identity includes the provider, project, credential hash, and UTC window. Changing a key or crossing UTC midnight invalidates it. Returned values are cloned so callers cannot alter the shared cache.
- Failed requests are cached for 30 seconds to avoid repeated provider load. Errors return unavailable values and a sanitized reason. Missing, null, inconsistent, or unexpected results are never converted to zero. Actual measured zero counts remain zero.
- The provider request uses `refresh: blocking`, which may reuse PostHog's own valid cache. A `last_refresh` older than five minutes makes the first three measurements `snapshot`; an impossible future refresh time is rejected. If no refresh time is supplied, `checkedAt` records the successful fetch time. The funnel retains its separate `needs_review` status and source timestamp.
- A 15-second deadline aborts the client request and also bounds a fetch implementation that does not settle on abort. Client cancellation does not guarantee cancellation of a query already running on the provider. The query itself remains bounded to 30 days; there is no polling loop, background refresh, unbounded history, person query, or dashboard write.

The cache is per server process, not a distributed cache or hard account-wide rate limit. The window and event filter bound work, but this implementation does not claim a measured query-cost benchmark.

## Verification

The focused Vitest suite checks UTC boundaries, mature funnel cohorts, alias collision prevention, scoped ownership, missing and measured-zero data, malformed/inconsistent results, secret filtering, safe host configuration, cache expiry/concurrency/credential changes, source freshness, provider errors, and abort deadlines. Route tests check authentication/authorization short-circuiting, project validation, and private response headers.

The corrected live read-only probe returned **HTTP 200** at `2026-09-07T23:26:40.043Z`, covering August 8–September 6, 2026 UTC. It measured **494 pageviews, 303 active tracking IDs, 1 opt-in event, and 1/121 qualified popup IDs converting within 24 hours (0.83%)**. The legacy event count was zero. These are a dated verification observation, not fixed dashboard values. The sanitized result is recorded in the local task artifact `tmp/deep-learn-yysILVsfLFM/hq-posthog-adapter-probe.json`.

The initial probe reached PostHog and returned HTTP 400 `illegal_aggregation`; the query was corrected before accepting the successful result above. Mocked test data is not treated as proof of provider query execution.

## Deferred Google Search Console source

An existing local scorecard generator and dated exports were found without starting authentication or calling Google. Its concrete data root is `vault/02-projects/babysential/reports/gsc-scorecards/data`, with the latest discovered directory dated `2026-08-15`. The generator exports `summary.json` containing the site URL, finalized date, generation time, and 7/28/30/90-day totals. No GSC adapter is enabled in this slice. Any later adapter must display these as dated snapshots, validate the site and complete window, and account for the old generator's missing-row-to-zero normalization.

## Primary references

- [PostHog querying API](https://posthog.com/docs/api/queries): query endpoint, Query Read permission, bounded queries, descriptive query names, cache refresh modes, and query cancellation.
- [PostHog query endpoint reference](https://posthog.com/docs/api/query): `HogQLQuery` request and response schema.
- [PostHog SQL data access](https://posthog.com/docs/data-warehouse/sql/data-access): event-table access for aggregate analysis.

References checked September 8, 2026. No SDK or additional analytics dependency was introduced.
