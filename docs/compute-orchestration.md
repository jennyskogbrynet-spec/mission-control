# Subscription-aware Mission Control

Mission Control keeps the project brief, capacity evidence, routing reasons and run receipts together. It does not merge provider accounts, make API usage part of a consumer plan, or inherit a conversation from another app automatically.

## Operating contract

1. Read the current project and task; check ownership and prior results before opening another job.
2. Specify one useful outcome, necessary capabilities, data scope, acceptance checks and a time budget. Use existing skills and a concise context packet.
3. Read `/api/compute`. Refresh the relevant supported account collectors before substantial work. A 24-hour inventory is not a dispatch-time balance.
4. Request `/api/compute/recommend`. A candidate needs a verified account/harness, model capability evidence, allowed billing mode and fresh evidence for every applicable quota window. Preserve the default 20% reserve.
5. Choose the suitable role before the model. Use a fast model for narrow tasks, a balanced model for ordinary implementation, and a deep model selectively for difficult decisions. A fresh independent reviewer can help, but agreement does not replace behavioral checks.
6. Execute through the supported harness with a persisted UUID. Record the actual session, observed model when available, result and limitations. An acknowledgment is not completion. Never replay an uncertain launch.
7. Review the exact output and update the shared task/vault context. No finding quotas, infinite review loops, paid fallback or tasks invented solely to consume an expiring allowance.

## What the capacity register means

- Accounts, pools, bindings and append-only observations are private workspace data. The source repository has no personal account seed or credentials.
- Quota observations store source time, window, unit and reset. Missing values stay unknown. A reset timestamp passing requires a new observation; it does not manufacture 100% remaining capacity.
- Claude session, all-model weekly and applicable model-specific limits all constrain the same work. Codex's general and Spark allowances are separate pools. Never add percentages from different plans together.
- At 15 minutes, evidence requires refresh before automatic execution; at 24 hours it is stale. Failed collection retains the last valid number for history while blocking launch.
- Local token costs and CLI `total_cost_usd` estimates are not subscription balances or invoices. Banked resets are informational reserves and are not redeemed by the monitor.
- A browser login proves the browser identity only. It does not authorize or identify a different CLI process. Announced models remain unverified until account/model access is established.

## Collection and daily routine

`scripts/compute-collect.py` reads the supported Codex account/rate-limit protocol, Claude's CLI usage view through CodexBar, and the Z.AI quota endpoint used by Z.AI's own plugin. The private mapping lives in `~/.openclaw/mission-control/compute-collectors.json`; it contains account hashes and inert profile references, not credentials. Collection is read-only by default; `--publish` appends observations to local MC.

OAuth identity is checked before and after collection. Subscription processes remove API/provider overrides. The default Codex account is retained; no global login or credential file is switched. Z.AI's quota response lacks account identity, so a successful quota read alone cannot verify a harness identity.

The daily Codex heartbeat **MC kapasitet og modellradar** also checks the registered browser-only usage pages through computer use, records failures/login requirements, and checks official release sources against local model availability. The collector status is stored in MC with the actual scheduler reference and next due time. It stays quiet while state is unchanged. It does not activate the product-work routine proposals.

Provider page details and exact collection commands are maintained in the canonical mission-control skill's `references/compute-orchestration.md`.

## Conversations and handoffs

| Surface | Operational path | Practical limit |
|---|---|---|
| Codex / ChatGPT desktop local work | Shared MC skill, authenticated local helper and native harnesses | A regular cloud chat does not gain local tools merely by using the same account. |
| Claude Code | Same canonical skill through `.claude/skills/mission-control` and the same MC task/context packet | Model sessions have different histories; read the task evidence rather than pretending to remember another host's conversation. |
| Mission Control | Project rooms, routing preview, bounded subscription text analysis and existing verified agent transport | Text analysis cannot claim it inspected a repository, searched the web or implemented code. |
| ChatGPT mobile | Official Remote connection to the trusted Mac Mini, using the same account/workspace | Phone pairing and a connected, awake host must be verified by the user. This is distinct from a normal mobile chat. |
| ChatGPT web custom MCP | Possible separate integration, subject to current plan support and authentication | Official help/developer pages currently disagree on plan-level write support. Do not expose localhost or claim mobile MCP support. |

Current primary references: [Codex account protocol](https://learn.chatgpt.com/docs/app-server), [Remote](https://learn.chatgpt.com/docs/remote), [Claude subscription SDK notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Z.AI coding plan](https://docs.z.ai/devpack/overview), [Grok FAQ](https://docs.x.ai/grok/faq). Checked 2026-09-08; runtime evidence takes precedence over assumptions about account access.

## Babysential routine proposals

These are proposals, not activated schedules. Resolve current task IDs and existing jobs before activation. A 2026-09-08 complete task inventory found 62 tasks in review, 3 in quality review, 5 awaiting an owner, 33 backlog and 151 done. Those counts are dated, not permanent UI defaults.

1. **Review queue completion:** after daily health results, select at most three unclaimed review tasks with concrete evidence. Reproduce the stated behavior, compare the actual changed code and close only with proof; otherwise return one precise fix. Use a balanced reviewer on a different provider where helpful. Budget 30 minutes, one active reviewer, no automatic re-run after ambiguity. Primary metric: verified closures and reopened defects, not comments or finding counts.
2. **One useful repair:** choose a reproducible blocker from existing QA/analytics results. Prefer fixing the QA first-token/timeout checks before drawing conclusions from their performance alarms, then user-impacting accessibility or onboarding issues. Make one isolated change with focused tests and one independent review. Budget 45 minutes, at most two repair attempts. Reuse existing QA jobs and avoid duplicate task creation.
3. **Source quality batch before reset:** when there is fresh surplus above reserve, select a small, already approved batch from the source-link backlog. Verify official replacements, preserve the article's meaning and distinguish redirects from dead sources. Public research can use Grok; a reviewer checks the resulting proposed changes. Budget five articles or 30 minutes. Health claims require their normal editorial verification. No automatic publication and no new batch if a review backlog is growing.

A reset-aware bonus applies only to a ready, valuable task that fits the selected harness. Shorter jobs may fit more safely near a reset; the system must not create new recurring jobs just to spend unused allowance.
