# Agent commands and bounded Grok research

## Commands

Agent responses expose `command_session_key` separately from the saved `session_key` setting. Discovery belongs to workspace 1, uses the registered `openclawId`, and prefers the dedicated MC conversation, then main. If neither exists, a registered identity can start `agent:<id>:mc`. Automatic lookup never targets a recent cron, subagent, or external conversation. An explicit operator-configured session remains authoritative for that identity.

The Command UI posts `{to, message}` to `/api/agents/message` and reuses its `Idempotency-Key` header after an uncertain response. The server calls `gateway call chat.send` with `deliver:false`. `status:accepted` means the gateway acknowledged the run; it is not completion. Transport failure or unrecognized acknowledgement returns `outcome_unknown`; inspect the session before intentionally starting a new command. Wake uses the same RPC and no longer changes an agent's status to idle just because its request was accepted.

The task dispatcher retains its existing daily invocation budget, claims, stable task idempotency keys and ambiguous-delivery safeguards. This change does not automatically resume local Codex/Buzz sessions or replay previously uncertain task dispatches.

## Grok Build research

Settings → Agent Runtimes → Grok Build now provides a research prompt, progress, cancellation and saved results. This is the local Grok Build CLI, separate from Grok Bot's cloud machine.

- `POST /api/agent-runtimes/grok/research`: `{prompt, idempotencyKey}` where the key is a UUID and the prompt is at most 6,000 characters. Returns 202 for running and 200 for the existing completed request.
- `GET` lists the latest 20 runs; `GET ?id=<UUID>` retrieves one.
- `DELETE ?id=<UUID>` stops a running process owned by this server and workspace.
- Operator role and primary workspace are required. No automatic research scheduling or retry is introduced.
- Model defaults to `grok-4.6`; operators can set `GROK_RESEARCH_MODEL`. Binary detection checks `GROK_BIN`, then `~/.grok/bin/grok`, then PATH.
- Each run starts a new session in a temporary empty working directory and isolated `GROK_HOME`. Existing Grok authentication is reused through a temporary symlink; credential contents are neither copied to the result store nor returned by the API. Compatibility discovery, global memory and leader reuse are disabled. The only enabled built-in tools are `web_search` and `web_fetch`; MCP, shell, read and edit tools are denied and subagents disabled.
- Limits: one active local research run, six turns, three minutes, 2 MB captured process output. The process group is terminated on cancellation/timeout.
- Results live under `<MISSION_CONTROL_DATA_DIR>/grok-research/<UUID>.json`; corresponding Grok session evidence is retained in `<UUID>-sessions/`. Raw stderr and credentials are excluded. Unknown/partial cost is `null`, never zero.
- A completed live research run is required before runtime detection reports authenticated. The verification is considered fresh for 24 hours; credentials existing on disk alone do not establish model access.

If MC crashes while research is running, the cross-process `active.lock` intentionally remains and the run is displayed as interrupted/ownership lost. Reconcile the recorded run and verify its Grok process has stopped before removing that lock; do not blindly replay it. This release does not implement recovery/resume of orphaned Grok processes or automatic publication of research into vault/task evidence.

## Validation, 2026-09-08

A real Grok Build 1.0.13 run on `grok-4.6` searched and fetched the official ACP website and completed in 19 seconds. The model returned the correct official URL and reported $0.02386524. Preserved local evidence: `tmp/mc-optimization-20260908/grok-smoke-data/grok-research/00a5339d-e696-444c-a81a-a80eff460c2d.json` and its session directory. The live test uses only a synthetic public documentation question and is not part of normal automated tests.

Focused tests cover command request/acknowledgement contracts, session selection, workspace isolation, retry identity, research result parsing, cancellation, timeout, concurrency, saved results and secret-free errors. Existing task-dispatch tests remain green. Production build and visual integration review are performed after merging this change.
