# Team & portfolio — from one loop to a practice

Everything else in this skill is written for one person wiring one host. But the store
is shared, and that changes the economics: a lesson one person's loop writes can rescue
another person's host, the same pain relearned by three people is a louder signal than
any single run, and a new hire can inherit years of accumulated workflow intelligence on
day one. This file is how a team turns scattered loops into a compounding practice.

Some of this is guidance a person acts on today; some names a dashboard/product surface
that would make it turnkey (flagged **[product]**).

## Contents

- [The rediscovery signal: where a team loop pays off](#the-rediscovery-signal-where-a-team-loop-pays-off)
- [The maturity model](#the-maturity-model)
- [Promotion as review](#promotion-as-review)
- [Onboarding: inherit the lore](#onboarding-inherit-the-lore)
- [Cross-host portability](#cross-host-portability)
- [Governance is mostly self-executing](#governance-is-mostly-self-executing)

---

## The rediscovery signal: where a team loop pays off

At single-host scale, `seen_count` is a promotion trigger. At team scale it is a
**rediscovery counter**: the same lesson climbing in count across **distinct authors and
scopes** is proof a pain is *shared*, not personal — and shared pain is exactly where a
team-wide loop or rule pays off most.

Find it with the tools that already exist:

- `lorekit dedupe` — near-duplicate lessons written independently by different people are
  one shared lesson wearing several names; the cluster's summed `seen_count` is the team
  signal.
- `lorekit invariants candidates` — ranks clusters by summed `seen_count` × distinct
  scopes, which is precisely "how many people, in how many places, hit this."
- **[product]** A dashboard "rediscovery radar" that surfaces cross-author clusters with
  a one-click "wire a loop here" would make this turnkey.

## The maturity model

The FAST → SLOW → compiled-invariant rungs describe one loop's lifecycle. Aggregated
across every host, they become a **portfolio view** that shows where the team's loops are
thin:

| Level | State | Evidence |
| ----- | ----- | -------- |
| **L0** | No loop | The host has no `loop::<host>-lessons` bucket |
| **L1** | Fast advisories only | Lessons accrue and are read; nothing promoted yet |
| **L2** | Slow promotions landing | Recurring lessons hardened into host rules (`status::promoted`) |
| **L3** | Compiled invariant | A mechanically-checked `obligations-map` entry, `gating` |

Plot each workflow's level against how many teammates actually run it. A high-traffic
workflow stuck at L0/L1 is the team's biggest missed compounding. **[product]** A
maturity board on `/insights` would render this from the tags and counters that already
exist.

## Promotion as review

Promoting a `repo::` lesson to a team rule is a governance moment, and it maps cleanly
onto a process the team already trusts — code review:

1. A promotion-eligible lesson (`seen_count >= 3` or `status::structural`) enters a
   "pending team rule" state.
2. A **second engineer** reviews it, exactly as they would a PR. The gate the loop
   computes automatically becomes the human checkpoint.
3. On approval, the promotion is a normal reviewed edit to the repo's rules/docs; add a
   `status::promoted` tag so it stops re-suggesting and stands as an audit trail.
4. On rejection, write a lesson about **why it was not generalized** — that reasoning is
   itself reusable.

## Onboarding: inherit the lore

Onboarding content does not need to be written — it is the exact bucket an agent already
reads at SessionStart, re-aimed at a human. Generate a new hire's "what this team learned
the hard way" brief from:

- the highest-`seen_count` and `status::promoted` lessons per repo (rules first),
- the `codebase-knowledge` hotspots and invariants (where the bodies are buried),
- ordered by rung: promoted rules, then advisories.

Because it is derived from the live store, it is never stale and needs no maintenance.

## Cross-host portability

Eight people on Claude Code, Cursor, and Codex normally fragment knowledge into per-tool
silos. The shared store lets host-diversity be an *asset* instead:

- **Host-tag every lesson** (the `host` field). A lesson read by a *different* host than
  wrote it is portable; one only ever read within its authoring host may be host-local.
- **A lesson proven across two hosts is stronger evidence** it is a real team rule than
  one seen within a single tool — weight it higher at promotion.
- At promotion to a team rule, **strip host-specific phrasing** ("in Claude Code, …") so
  the rule reads for any host.

## Governance is mostly self-executing

The failure mode of "team governance" is that it assumes a human process watching loops
decay — which solo devs and small teams skip, so entrenchment guards rot. Lean on the
mechanisms that need no staffing:

- **TTL expiry** drops stale lessons automatically — decay is built in, not a chore.
- **The recurrence gate** means a single bad run can never rewrite a host.
- **The injection cap** bounds read cost no matter how the bucket grows.

The only step that genuinely needs a human is **promotion review** above. Keep the
staffed surface that small; let the defaults do the rest.
