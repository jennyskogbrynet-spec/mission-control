# Panels and `MC_HIDDEN_PANELS`

Mission Control ships every panel it has ever grown, because it is a general
product. A single installation uses a subset. The rest are three separate costs:
an operator scanning a rail of 27 entries to find the four they use, a reviewer
having to reason about surface nobody exercises, and a test suite paying for
paths no one runs.

`MC_HIDDEN_PANELS` lets an installation say which panels it does not use,
without anyone deleting a panel that another installation needs.

## How it works

```
MC_HIDDEN_PANELS=webhooks,github
```

- Comma-separated panel ids. Whitespace and casing are forgiven; empty segments
  and duplicates are dropped.
- Read **server-side** in `getCapabilities()` (`src/app/api/status/route.ts`) and
  delivered to the browser as `hiddenPanels` on `/api/status?action=capabilities`,
  the same route that already carries `interfaceMode`. The raw environment value
  never reaches the client bundle.
- Parsing lives in `src/lib/panel-visibility.ts` (`parseHiddenPanels`,
  `isPanelHidden`); the nav rail applies it in `filterItems`
  (`src/components/layout/nav-rail.tsx`), after the existing local-mode,
  admin-only and essential-mode filters.
- **The default is empty.** No default list is set in code: a hard-coded default
  would turn one installation's opinion into everyone's behaviour. The list below
  is a recommendation for this installation, applied through the environment.

### What it does and does not do

- It removes entries from the navigation rail. A group whose entries are all
  hidden disappears with them, and a parent whose children are all hidden
  disappears too — that fallout is the existing `filterItems` recursion, not
  new behaviour.
- It does **not** 404 or redirect a direct URL. Every panel is served by one
  catch-all client route (`src/app/[[...panel]]/page.tsx`), and turning an
  unlisted id into a 404 there would also swallow plugin-supplied panels, whose
  ids are not knowable at that point. Direct navigation therefore still renders
  a hidden panel.
- Consequently this is a **decluttering control, not an access control**. Never
  use it to keep an operator away from something they may not see; role checks
  (`requireRole`) and the admin-only set are where that belongs.
- An unknown id in the list is ignored. Nothing validates the value against the
  panel registry, so a typo silently hides nothing — check the rail after a
  change rather than trusting the variable.

## Recommended list for this installation

Measured 2026-09-09 10:30 on this machine.

| Panel id | Measured state | Recommendation |
|---|---|---|
| `webhooks` | 0 webhooks configured, 0 deliveries | **hide** |
| `github` | GitHub sync not configured | **hide** |
| `alerts` | 0 alert rules | candidate — see below |

```
MC_HIDDEN_PANELS=webhooks,github
```

`alerts` measured the same as `webhooks` (zero configured) and is a reasonable
addition, but it was not in the brief's list and is left to an explicit decision
rather than folded in silently.

## Two items that this control cannot address

The original request named four things to hide. Two of them are not panel ids,
and saying so is more useful than inventing ids that would quietly hide nothing.

**`super/tenants` — multi-tenant admin.** The `/api/super/*` endpoints
(`tenants`, `os-users`, `provision-jobs`) and `SuperAdminPanel` are unused in a
single-family installation. But `SuperAdminPanel` has **no entry in `navGroups`**
at all: it is already unreachable from the rail and is only reachable by direct
URL. `MC_HIDDEN_PANELS` operates on nav entries, so it has nothing to remove
here. Reducing that surface means removing the routes or gating them behind a
capability check — a separate change, with its own review, because it touches
API surface rather than presentation.

**`integrations-not-configured` — the 12 unconfigured integrations.** There is
one `integrations` panel, and it mixes 4 connected integrations with 12 that are
`not_configured` (`src/components/panels/integrations-panel.tsx`). Hiding the
panel would hide the four that work in order to hide the twelve that do not, so
it is **not** recommended here. The honest fix is a filter inside the panel that
defaults to showing configured integrations first — panel-internal work, not a
navigation flag.

## Adding a panel to the list

1. Find the id in `navGroups` in `src/components/layout/nav-rail.tsx`. The id is
   what goes in the variable, not the label.
2. Add it to `MC_HIDDEN_PANELS` in the deployment environment.
3. Restart the server — `getCapabilities()` reads `process.env` per request, but
   Next only re-reads the process environment on restart.
4. Confirm in the rail. Nothing validates the id, so a typo fails silently.
