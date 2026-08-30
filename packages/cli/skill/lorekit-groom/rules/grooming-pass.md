# The grooming pass — playbook

A single, repeatable pass over the lessons for a scope. The first four phases are
read-only; nothing is mutated until a human has seen and approved the plan.

Work **one scope at a time**. A whole-store pass in a single breath produces a
wall of proposed changes no one can review; a scope at a time keeps each
confirmation small enough to actually read.

---

## Phase 1 — Survey (read-only)

Size the problem before touching it, so you groom where the mass actually is
rather than wherever you happened to look first.

```bash
lorekit stats            # counts per scope and per store — where the mass is
lorekit scopes           # every scope in the store + its lesson count
```

`scopes` is the one command that is store-wide rather than cwd-scoped, so it is
how you notice a `branch::…` scope you had forgotten about, or a scope with
hundreds of lessons that dwarfs the rest. Neither command reports a
last-activity date — the inventory is counts only — so judge staleness from the
lessons themselves once you narrow in. Read both, then pick the noisiest scope as
the target for this pass and narrow to it with `--scope <scope>` from here on.

**Large scopes:** when a scope has more lessons than a single page, use:

```bash
lorekit list --all --scope <scope>           # drain all pages; tags each lesson with its updated date
lorekit list --all --scope <scope> --max 500 # cap at 500 to get a representative sample
lorekit list --all --scope <scope> --since 2024-01-01  # only lessons created since that date
```

The remote store is paginated (default 50 entries per `list` call, 100 per
`lint`/`dedupe` call). `--all` drains every page; `--max` applies a hard cap
(default 5000). `lint` and `dedupe` default to full-scope survey — add `--max`
or `--since` when the population is large enough to slow things down.

## Phase 2 — Lint (read-only)

```bash
lorekit lint --json --scope <scope>
```

Findings are structural, not semantic — each names its rule:

- **empty-value / short-value / untrimmed-value** — the lesson carries little or
  no signal, or has stray leading/trailing whitespace.
- **empty-key** — no key to address it by.
- **volatile-key** — the key carries a per-sighting identifier (a run of 6+
  digits such as a GitHub comment id, or a `pr<n>` / `issue<n>` segment), so it
  never collides with a later write, never dedups, and leaves `seen_count`
  frozen at 1. Re-key it onto the structural pattern and move the identifier
  into the body.
- **malformed-scope** — the scope string is invalid.

These are the cheapest wins and the least controversial, so clear them first.
For each: either **fix it in place** (rewrite a too-short value into a real
observation, trim whitespace — a `memory.write` to the same `scope`+`key`
updates in place) or, if the lesson is genuinely empty of meaning, **queue it for
removal** in the plan. `lint` exits non-zero while findings remain, which also
makes it a clean CI gate — a passing `lint` is your Phase 6 proof.

## Phase 3 — Dedupe (read-only)

```bash
lorekit dedupe --json --scope <scope> --threshold 0.85
# For large scopes, narrow the population:
lorekit dedupe --json --scope <scope> --threshold 0.85 --key-prefix "debug-" --max 1000
lorekit dedupe --json --scope <scope> --threshold 0.85 --since 2024-01-01
```

Each cluster is a set of lessons whose values overlap heavily by word tokens.
Start high (`0.85`) to see the confident duplicates, then re-run lower (`0.75`,
`0.7`) to surface looser paraphrases — but the lower you go, the more the
clusters are coincidental overlaps rather than true duplicates, so read more
carefully.

`dedupe` surveys the full scope by default. When the population exceeds 2000
entries it stops and prints a narrowing warning — use `--key-prefix` to focus
on a key namespace, or `--since` to limit the date range. The `--max` flag sets
a lower cap (default 5000, internal safety cap at 2000).

For every cluster you intend to act on, read the members in full first:

```bash
lorekit show <scope::key> --json
```

You are deciding whether these lessons *mean* the same thing, which the score
cannot tell you. Only clusters that survive that read become merges in the plan.

## Phase 4 — Build and propose the plan

Turn Phases 2–3 into one concrete, scannable proposal. Group it by action and
show the real content, because a human approving a shared-store change needs to
see what actually changes, not a count:

```text
MERGE (3 → 1) in repo::acme/api
  keep/new key: db-migrations-need-explicit-tx
  merged from:
    - repo::acme/api::migrations-wrap-in-transaction   "wrap every migration in a tx…"
    - repo::acme/api::tx-around-schema-changes          "schema changes need a transaction…"
    - repo::acme/api::migration-atomicity               "migrations must be atomic…"
  proposed value: "<the synthesised lesson>"

EXPIRE (set TTL)
    - branch::acme/api::feat-x::stub-endpoint-shape  → ttl_days: 14  (branch-scoped, short-lived)

ARCHIVE (reversible)
    - repo::acme/api::old-node-14-workaround         (node 14 dropped; superseded)

DELETE (permanent — junk only)
    - repo::acme/api::asdf                            (empty value, no key meaning)
```

Then stop and get confirmation. See
[references/merge-and-expiry.md](../references/merge-and-expiry.md) for how to
synthesise a merged value, choose its scope and key, pick a TTL tier, and decide
archive vs delete — those are the judgement calls, and getting them right is the
whole point of doing this by hand rather than by script.

## Phase 5 — Apply (only after confirmation)

Apply in an order that never loses information, because the store is the only
record — there is no undo for a hard delete:

1. **Fixes and merges first — write before you remove.** Write the corrected or
   merged lesson (`memory.write`, or `lorekit write`). Confirm it landed
   (`lorekit show <scope::key>`) *before* removing any source lesson, so a
   failure mid-way leaves the originals intact rather than a gap.
2. **Expiries.** `memory.write { scope, key, ttl_days }` on the lessons that get
   a TTL, or `{ clear_ttl: true }` to make one permanent again. Same key updates
   in place — no new lesson is created.
3. **Removals last.** Archive (`memory.archive`, reversible) for anything a
   future run might still want; `memory.delete { force: true }` (permanent) only
   for the junk explicitly approved for deletion. Remove the merge sources here,
   once their replacement is confirmed written.

Preserve `tags` and provenance when you rewrite a lesson — carry the union of the
sources' tags onto a merge so the consolidated lesson stays as findable as the
originals were.

## Phase 6 — Verify (read-only)

```bash
lorekit lint --scope <scope>              # expect exit 0 — clean
lorekit dedupe --scope <scope> --threshold 0.85   # expect no clusters
lorekit stats --scope <scope>             # expect a lower count than Phase 1
```

Report the before/after: lessons removed, clusters merged, expiries set, and the
new count. Then either move to the next scope or close out the pass.

---

## Guardrails

- **Read before you remove.** Never delete a merge source until its replacement
  is written and confirmed.
- **Archive beats delete.** Prefer the reversible path unless the lesson is
  provably junk (a lint casualty) and the human approved permanent removal.
- **The score is a hint, not a verdict.** A dedupe cluster is a candidate to
  read, not a merge to execute.
- **One scope, one confirmation.** Keep each proposed batch small enough to
  actually review.
- **Someone else's lesson deserves more caution.** A lesson tagged from another
  agent or a teammate is not automatically yours to delete — when in doubt,
  archive rather than hard-delete, and flag it in the plan.
