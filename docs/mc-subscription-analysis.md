# Subscription-backed packet analysis

Mission Control can send one bounded analysis packet through **Claude Code's existing subscription login** and persist its result. This implements a real headless handoff, not merely a routing recommendation. This first mode cannot read a repository, search the web, execute commands, edit files, run tests, or change a task's lifecycle. A task ID only links the receipt to that task.

The design adapts role-first routing and evidence-backed completion from [Claudex Route](https://github.com/chaseai-yt/claudex-loop/tree/8cf5e2c1771c5151d90c12642391d0ba8fa71b0e). No upstream runner/plugin was installed or executed. Research evidence is in the dated local deep-learn note; this implementation is separate from that source's claimed live tests.

## Private launch configuration

Create an owner-only (`0600`) regular JSON file at `~/.config/mission-control/subscription-runs.json`, or set the server's `MC_SUBSCRIPTION_RUNS_CONFIG` to its absolute path. Configuration is an operator-maintained allowlist outside the database; there is no API for executable paths, environments, profile paths or shell commands.

```json
{
  "version": 1,
  "bindings": [{
    "bindingId": "example-claude-binding",
    "accountId": "example-account",
    "runtimeId": "claude-code",
    "executable": "/absolute/path/to/claude",
    "identityFingerprint": "sha256-of-normalized-subscription-email",
    "modelIds": ["exact-verified-model-id"]
  }]
}
```

The placeholder fingerprint must be replaced by the actual 64-character lowercase SHA256. No personal account IDs, emails, paths or credentials are shipped in source. The binding must match compute account, runtime, fingerprint and model; duplicate allowlist matches are rejected. The selected model must have verified `analysis` capability and an appropriate difficulty tier. Latest access and all applicable quota windows must remain executable under the compute policy, including the 20% reserve. API billing and restricted data are excluded.

Immediately before starting the model, the adapter runs the chosen CLI's supported `auth status --json`, requiring Claude.ai subscription auth, first-party provider, a recognized subscription and the matching identity fingerprint. It then rereads the compute policy. API keys, custom endpoints, third-party provider variables and copied OAuth tokens are not inherited. Normal HOME/USER/LOGNAME and macOS session variables are retained because the actual Mac's Keychain lookup failed when those were stripped. This does not sign in, sign out or switch any account.

Claude Code 2.1.245 locally confirms `--safe-mode`, `--tools ""`, strict empty MCP, no Chrome, disabled skills, no persisted conversation and `dontAsk` permissions. The 8-turn flag was also accepted by the installed CLI. A version/help check does not prove the selected model is runnable; that requires a completed real invocation. The default Claude subscription authentication probe was checked without launching a model.

`codex-cli` and `zai-claude-code` may be represented in the private schema but are deliberately rejected by this implementation. The installed Codex CLI supports read-only sandboxing, which alone does not establish tools-disabled packet isolation; no stronger claim is made. A Z.AI coding-plan wrapper needs its own verified identity/billing contract and is not substituted for normal Claude OAuth. The compute preview can recommend these runtimes for other purposes; preview eligibility is not packet-analysis launch support.

## API

All routes require operator access and explicit workspace 1 **and** tenant 1. GET responses are no-store. The route validates project ownership and, if supplied, task/project/workspace membership before execution. It neither claims nor changes the linked task; requesting packet analysis does not execute its implementation work order.

- `POST /api/compute/runs`: strict `{idempotencyKey:UUID, projectId, bindingId, modelId, prompt, difficulty:'routine'|'standard'|'complex', dataClass:'public'|'internal', taskId?}`. Prompt 1–12,000 characters; body at most 32 KiB even without a Content-Length header. Credential scanner rejects the prompt and unsafe returned text. The scanner is a defense against recognizable credentials, not a universal personal-data classifier.
- `GET /api/compute/runs?id=UUID`: `{run}`; no ID returns `{runs}` with the latest 50 receipts. UUID is exactly the POST idempotency key, so an uncertain HTTP response can be reconciled with GET without launching again.
- `DELETE /api/compute/runs?id=UUID`: returns 202 `{status:'stopping'}` only when this server process owns a live child. This is a stop request; GET must confirm its final receipt.
- `PATCH /api/compute/runs`: `{action:'reconcile',id:UUID}`. Confirms owner and child processes/process group are gone and that the preserved lock belongs to this run, then marks interrupted and releases the lock. It never resends the packet.

POST returns 202 for preflight/running, 200 for a saved terminal receipt, including a preflight identity failure where no model request was sent. Errors: 400 invalid schema/JSON; 401/403 auth/ownership; 404 project/task/run missing; 413 body too large; 422 credentials; 409 policy/allowlist/idempotency/lock/reconciliation conflict; 429 throttled; 500 sanitized unexpected error. Do not retry POST automatically after network uncertainty. Preserve the UUID and exact packet and read its receipt first.

A run records project/task/binding/account/runtime, mode `packet_analysis`, requested model, all `observedModels` plus `observedModel` when the provider reports exactly one, session UUID, prompt, final Markdown, timestamps, evidence observation IDs and limitations. It distinguishes `preflight`, `running`, `completed`, `failed`, `interrupted`, and `unknown`. Unknown observed model stays null; any reported model different from the explicitly requested ID fails rather than silently claiming the requested model ran. `estimatedCostUsd` is Claude's client estimate; `billedCostUsd` remains null. Neither means quota remaining or subscription cash spent. Render Markdown with the existing safe renderer; do not enable raw HTML, arbitrary URL schemes or remote image fetching.

### Background model selection

`--model` selects the main turn but does not, by itself, select every ancillary request. A live text-analysis receipt exposed both the requested Sonnet and an unrequested Haiku model; the existing mismatch guard correctly failed that run. Its receipt remains unchanged.

The child environment now sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` to the same explicit model selected for the run. Anthropic documents this variable for the Haiku alias and background functionality in [model configuration](https://code.claude.com/docs/en/model-config#environment-variables). The installed Claude Code 2.1.245 model resolver was inspected on 2026-09-08: it reads this override before its built-in Haiku default. The legacy `ANTHROPIC_SMALL_FAST_MODEL` takes precedence when present; the runner's existing environment allowlist excludes it, along with inherited provider credentials and endpoint overrides. The setting exists only in the child environment; it does not change global preferences or authentication.

This pins the supported background-model path, not every possible future CLI request. All reported model IDs remain visible and checked; an unexpected ancillary model still fails the run. Tools and subagents remain unavailable. Do not replace this guard with filtering, model-name relabeling, or an automatic retry. A new logical live canary must verify actual `observedModels` after deployment; fixture tests and installed-code inspection alone do not prove the provider used only the selected model.

## Lifecycle guarantees and boundaries

The adapter creates a cross-process installation lock and persists the UUID/payload hash before any model launch. The payload hash covers the validated, normalized packet. Same UUID and packet returns existing evidence; changed packet conflicts. One process owns one child. Every run has a 10-minute total bound, at most 8 Claude turns, and a combined 2 MB output bound. Stdin carries the packet; the prompt is never interpolated into shell text. No shell is spawned by the controller.

The child uses an isolated temporary directory with no project context. A zero exit code is insufficient: the terminal envelope must report success, the exact session UUID, nonempty safe text, and no denied tool actions. Missing/failed/ambiguous output is failed; timeout/cancellation is interrupted. No automatic model/provider fallback or retry exists. Raw credential-bearing stderr is drained and not exposed to the UI.

A restart cannot claim success: receipts without a live owner project as unknown and preserve their lock. Reconciliation checks recorded processes before releasing it. If a crash lost the child PID after a possible spawn, the API cannot prove process death and refuses to unlock; local inspection is required. Failure to persist a post-launch outcome also preserves the lock. This is a local single-installation executor, not a durable distributed worker service. It cannot resume a lost model session because this mode intentionally disables session persistence. Operators retain the uncertainty and may explicitly create a new logical request only after reconciliation.

## Verification

Focused fixture tests exercise account/policy mismatch, exact session completion, unexpected model, empty/denied/secret output, payload replay/conflict, two manager instances, output limits, cancellation, corrupted evidence, orphan reconciliation, workspace/tenant guards, project/task ownership, request-size bounds, and sanitized error responses. They do not consume model quota or prove live model availability. The integration owner performs the real authorized API-to-subscription canary after adding private launch configuration and fresh compute observations. No full build or production database mutation is part of this worker's verification.
