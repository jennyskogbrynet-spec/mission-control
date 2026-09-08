# Ines Headquarters

`HeadquartersPanel` is exported from `index.ts` and `headquarters-panel.tsx`. The component owns its internal view/project/search selection; the parent owns dashboard navigation and route integration. All displayed documents, links, tasks, agents, activity and metrics come from the typed headquarters API. There are no production fixtures or simulated actions.

## API use

- `GET /api/headquarters`: initial snapshot and a non-overlapping 60-second refresh while the page is visible.
- `GET /api/headquarters/knowledge?q=…&project=…`: debounced QMD/local search; `project` is omitted for all projects. Local indexed matches remain available on search failure.
- `GET /api/headquarters/knowledge?id=…`: original markdown for the selected note. Aborted/stale responses cannot overwrite a newer selection.
- `GET /api/headquarters/metrics?project=…`: fetched and polled only in Analyse.
- `POST /api/headquarters/tasks`: explicit editable form validated by the same `hqTaskInputSchema` as the API, with 1–20 required source IDs, 1–10 acceptance criteria, expected outcome and an idempotency key. String input limits come from the shared schema; invalid payloads cannot POST even when native browser checks are bypassed. An uncertain network response locks the submitted payload and retries with the exact same key.
- `POST /api/headquarters/tasks/:id/evidence`: records actual result evidence; `saveLearning: true` additionally requests a vault learning. A returned top-level `learningNoteId` opens through the knowledge endpoint. The UI never sets a task's done status from this operation.

Original source links point **note → task**. `learningNoteIds` point **task → learning note** with relation kind `evidence`; generated learning is not presented as original source evidence.

Task navigation uses the existing `panelHref('tasks')?taskId=…` contract. It clears the global project filter via the public store setter before opening, because the existing task board filters its data before resolving `taskId`.

## Rendering and limits

The source graph is a bounded view of real resolved links, with the selected object's neighborhood prioritized. 2D positions group document types; 3D positions are layout only. Neither mode claims semantic distance or a time series. A keyboard-friendly list exposes the same objects, with incremental display. Dense 2D columns scroll internally instead of overlapping labels. 3D loads lazily and has an error-boundary fallback; it does not auto-rotate.

The markdown reader uses ReactMarkdown + remark-gfm, without raw HTML plugins or HTML regex stripping. Images become text references and cannot trigger remote image requests. External links are restricted to HTTP(S). Evidence additionally permits only the exact relative run-provenance route `/api/v1/runs/[a-zA-Z0-9_-]+/provenance`; other relative paths and protocols are rejected. Links use `noopener noreferrer` and suppress referrer transmission. Code and prompt literals remain intact. A conservative presentation helper removes only a recognized opening metadata block; later rules, fenced examples and the API source string stay unchanged.

Unknown measurements are not converted to zero. Actual zero is preserved. Source dates, last-modified timestamps, fetch timestamps, index truncation and stale/error states remain distinct. Date-only sources do not acquire an invented clock time. A failed or in-progress metrics refresh changes retained cards to a stored/unconfirmed display badge without altering original values or checkedAt. Task summary labels explicitly refer to the prioritized maximum-200-task selection, not all historical tasks.

Styles are confined to `headquarters.module.css`, including responsive container queries, native controls/dialog, visible keyboard focus and reduced-motion behavior.

## Validation

```sh
pnpm exec vitest run src/components/headquarters/headquarters.test.tsx
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint src/components/headquarters
```

All passed in the implementation run (23 targeted tests). Tests cover real source/result relationship direction, shared/project scope, priority filtering, date precision, aborted and racing requests, task idempotency, markdown safety and code preservation, null versus zero measurements, persisted evidence/learning handoff, mandatory source selection and shared input limits, and actionable but narrowly restricted relative provenance links. Parent integration/browser/deployment QA remains separate.

Final stale-state verification also passed the independent reviewer fixture: `pnpm exec vitest run --config /private/tmp/ines-hq-independent-review/ui-vitest.config.mjs` (1 test).
