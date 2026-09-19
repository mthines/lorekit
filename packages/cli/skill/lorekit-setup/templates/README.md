# Loop recipe cards

Copy-paste starters for wiring a self-improvement loop into a host. Pick the card
that matches your host, paste its read/write steps at the seams it names, and fill in
`<host>` / `<owner>/<repo>`. Each card already bakes in the five non-negotiables from
the skill's [Non-negotiables](../SKILL.md#non-negotiables-do-not-optimize-these-away):
a per-host **injection cap**, a **TTL**, the **advisory-only** contract, the **body
contract** (pure markdown), and a **fire-once check** so you prove the loop closes
before you trust it.

| Card | Use it for | Shape |
| ---- | ---------- | ----- |
| [code-changing-agent.md](./code-changing-agent.md) | A host that edits code and can fail in recurring ways (an autonomous workflow, a fix/implement agent) | Lessons loop + the shared `codebase-knowledge` read/write |
| [reviewer-reconcile-host.md](./reviewer-reconcile-host.md) | A host that posts durable outputs at a shared target it revisits (a PR reviewer, a triager, a linter that files tickets) | Lessons loop + the reconcile-on-re-run Signal bucket |
| [multi-step-orchestrator.md](./multi-step-orchestrator.md) | A pipeline that fails in classifiable ways (wrong triage, a missed step, a false-green gate) | The plain two-tier lessons loop |
| [ci-job.md](./ci-job.md) | A deterministic job that needs last-run state (flaky set, last deployed SHA, a baseline) | JSON state records, not lessons |

Every card is a *starting point*, not a spec. The authoritative rules are one level up:
[self-improvement-loops.md](../rules/self-improvement-loops.md) (lessons),
[ci-state-records.md](../rules/ci-state-records.md) (state records),
[proving-improvement.md](../rules/proving-improvement.md) (proof),
[loop-health.md](../rules/loop-health.md) (maintenance).

**`N` — the injection cap — is `5` in every card by default.** Raise it only with a
reason; a loop that reads 30 lessons into every run is why agents learn to ignore
injected lore. See [Non-negotiables #2](../SKILL.md#non-negotiables-do-not-optimize-these-away).
