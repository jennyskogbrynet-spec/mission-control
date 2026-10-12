# Factory dispatch scope: the morning meeting decides, the factory executes

Mission Control's own dispatch is the scheduler job `task_dispatch` (`src/lib/scheduler.ts`):
`autoRouteInboxTasks()` (inbox → assigned) then `dispatchAssignedTasks()` (assigned →
in_progress, i.e. an agent invocation). Agents can also pull work with
`GET /api/tasks/queue` (MCP `mc_poll_task_queue`). Since F2 both are braked three ways.

| Setting | Values | Absent means |
|---|---|---|
| `general.task_dispatch` | `true` / anything else | **off** (kill switch; re-read before every claim, manual trigger included) |
| `general.task_dispatch_scope` | `approved_only` / `all` | `approved_only`. Only the exact string `all` restores the legacy whole-queue behaviour. Do not use `all`. |
| `general.task_dispatch_approved` | JSON written by `POST /api/tasks/dispatch-approved` | nothing is approved: dispatch moves nothing |

Under `approved_only`:

- Only tasks in the current approved list, or with `metadata.outcome_task_id` equal to a
  listed id (same workspace, one level, at most **5** per outcome, lowest ids first), are
  routed, dispatched, handed out by the queue or stale-requeued.
- A listed task is routed only to its approved `owner`, and dispatched only while
  `assigned_to` equals that owner. Children are routed by the usual scoring.
- At most **3** factory tasks `in_progress` at once, re-checked before every claim. The cap
  counts every `in_progress` row that is eligible now or assigned to an MC agent, so runs
  started under yesterday's list still count after the list changes. Rows of other lanes
  (`claude-code:*`, `codex:*`, people) do not, so they cannot hold the cap shut. The plan
  shows the ids holding it (`wip.holding`) and the total of every lane.
- The queue still returns an agent's own running task (`continue_current`); a new claim
  answers `reason: dispatch_held` while the switch is off or the list is held.
- A list older than **36 h** (server-stamped `approved_at`), missing or unparseable holds
  everything. Each held tick writes an activity line `task_dispatch_held`, at most one per
  hour per reason. It never falls back to `all`.
- The factory never sets `done`, never creates tasks and never starts a release.

**MC dispatch only runs tasks owned by an MC agent** (a row in `agents`: reidar, stella,
vera, …). A task owned by `claude-code:*`, `codex:*` or `ines` is not dispatchable by MC;
the plan reports it (`assignee_not_an_mc_agent`, `owner_not_available`). Those outcomes are
executed by their native lane, not by this scheduler.

## Morning procedure

1. The meeting writes `approved-outcomes.json` (template below) and checks it with
   `ines-commute morning --snapshot … --outcomes approved-outcomes.json --output agenda.md`.
2. For each outcome MC itself should run: the task is `assigned` to its owner (an MC agent).
   An `inbox` task with an assignee is not picked up; set `status=assigned`.
3. Load it (dry run first; `--apply` writes):

   ```bash
   node scripts/mc-factory-hygiene.mjs approve --outcomes /absolute/approved-outcomes.json
   node scripts/mc-factory-hygiene.mjs approve --outcomes /absolute/approved-outcomes.json --apply
   ```

   The server validates against the live board (1–3 outcomes, `approved: true`, owner = the
   task's single observed owner, non-empty `sources` and `acceptance`, `--date` today or
   yesterday), stamps `approved_at` and returns the resulting plan. It never touches
   `general.task_dispatch`. Re-sending the outcomes already stored does not restart the
   36 h clock (`UNCHANGED`); an outcome that continues from yesterday must be approved
   again with `--reapprove`, or the factory holds once the 36 h run out.
   An outcome's first 5 children (lowest ids, finished ones included) are eligible; more
   than that is a sign to split the outcome in the meeting.
4. Check what the next tick would take, without moving anything:

   ```bash
   node scripts/mc-factory-hygiene.mjs dispatch --plan
   ```

5. Starting the factory (`general.task_dispatch=true`) is a separate, explicit decision.

## `approved-outcomes.json` template

```json
[
  {
    "task_id": 1234,
    "owner": "reidar",
    "approved": true,
    "outcome": "One sentence: what is true tonight that is not true now.",
    "sources": ["MC 1234", "vault/02-projects/…"],
    "acceptance": ["PR merged with CI green", "evening report shows the receipt"]
  }
]
```

## API

- `GET /api/tasks/dispatch-plan` (viewer): read-only preview of the next tick.
- `GET /api/tasks/dispatch-approved` (viewer): the stored list, `fresh|missing|stale|invalid`.
- `POST /api/tasks/dispatch-approved` (admin): `{outcomes, date?, apply?, reapprove?}`; dry
  run unless `apply === true`; 422 with `errors[]` when it does not validate.
- Trust boundary: an admin can still write `general.task_dispatch_approved` directly with
  `PUT /api/settings`; the reader validates the shape and the 36 h clock, not the author.
