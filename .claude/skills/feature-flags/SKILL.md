---
name: feature-flags
description: >
  Adds, updates, or removes a LoreKit feature flag end-to-end: the
  registry.ts entry, codegen regeneration, tests, and — for a flag that
  changes what renders — the copy-and-suffix UI-variant scaffold (a resolver
  component plus one whole, standalone component per arm, never inline
  branches inside one component). Reads packages/feature-flags/CLAUDE.md and
  docs/feature-flags.md as the source of truth rather than guessing at the
  schema. Triggers on "add a feature flag", "create a new flag", "set up an
  A/B test", "update the <flag> flag", "remove/delete the <flag> flag",
  "/feature-flags".
argument-hint: '[add|update|remove] <flag-key>'
license: MIT
metadata:
  author: mthines
  version: '1.0.0'
  workflow_type: applied
  tags:
    - feature-flags
    - openfeature
    - a-b-testing
    - codegen
    - lorekit
---

# Feature Flags

Adds, updates, or removes an entry in `@lorekit/feature-flags`' registry —
end to end: the data, the generated bindings, the tests, and (when the flag
changes what renders) the copy-and-suffix component scaffold. The goal is
that adding a flag is a five-minute, mechanical task with a hard gate at the
end, not something that needs re-deriving the schema and the conventions
from scratch every time.

> **Read before making any change:**
> [`packages/feature-flags/CLAUDE.md`](../../../packages/feature-flags/CLAUDE.md)
> (rules + file map) and
> [`docs/feature-flags.md`](../../../docs/feature-flags.md) (the full guide —
> value types, bucketing, overrides, telemetry, `packages/web` integration,
> the UI-variant convention). This skill sequences the work; those two files
> are the source of truth for what a valid flag/registry entry looks like.

---

## Mode detection

| Mode | Trigger |
|------|---------|
| `add` | Default. "add a flag", "create a flag", "set up an A/B test", or the named flag key doesn't exist in `packages/feature-flags/src/registry.ts` yet. |
| `update` | "update/change/rebalance the `<key>` flag", or the named key already exists and the ask changes its shape (variants, weights, description, enable/disable the experiment). |
| `remove` | "remove/delete/clean up the `<key>` flag", or the ask is "the experiment is over, ship the winner." |

State the mode and target flag key before continuing:

```
Mode: add
Flag: usage-charts-v2
```

If the request is ambiguous about whether the flag needs a UI-variant
scaffold (see Step 3 below), ask — don't guess. A boolean gating one prop and
a full copy-and-suffix component split are very different amounts of work.

---

## Workflow: `add`

1. **Confirm it doesn't already exist.** `grep -n "key: '<flag-key>'" packages/feature-flags/src/registry.ts`. If it does, this is `update`, not `add`.
2. **Gather the shape** (ask if not stated, don't invent):
   - `key` — kebab-case (`FLAG_KEY_PATTERN` in `schema.ts`).
   - `description` — one sentence, plain language; this is the ONLY place the flag's intent is documented besides the flag's own consumers, so make it stand alone.
   - `type` — `boolean` | `string` | `number` | `object`. See `docs/feature-flags.md` § "Value types" — `object` accepts arbitrary nested JSON, with no per-flag TypeScript shape.
   - `variants` — variant key -> value, matching `type`. Name variants `control`/`treatment` for an A/B test, `off`/`on` for a plain toggle, or whatever domain-appropriate pair fits — see the existing registry for both styles.
   - `defaultVariant` — must be a key of `variants`.
   - `experiment` (optional) — omit entirely for a plain toggle. If present: `enabled: true/false`, and `variants: [{ key, weight }, ...]` with weights summing to exactly 100 across 2+ arms.
   - `owner` — the package/team, e.g. `'@lorekit/web'`.
   - `tags` — short, freeform.
3. **Decide: does this flag change UI shape, or gate one small read?**
   - **Changes what renders** (a whole component's layout/content differs per arm) → scaffold the copy-and-suffix pattern now, before wiring anything:
     - `ComponentName.tsx` — the resolver. Dispatches on `useFeatureFlagVariant('<flag-key>')` (client) or `(await evaluateFlagDetails('<flag-key>', context)).variant` (server) — the VARIANT KEY, never the raw value.
     - `ComponentName.<variantKey>.tsx` per arm — a whole, standalone component. No shared inline branch, no prop threading between arms beyond what each needs on its own.
     - A real, working instance to copy the shape from:
       `packages/web/src/components/dashboard/onboarding-preview/` (`OnboardingPreview.tsx` + `.control.tsx` + `.treatment.tsx`).
     - Full rationale: `docs/feature-flags.md` § "UI variants: copy-and-suffix, never inline branching".
   - **Gates one small prop/value** (a boolean deciding which of two near-identical calls to make, a copy string, a numeric threshold) → skip the scaffold. Call `useFeatureFlag`/`getServerFlag` directly at the point of use.
4. **Add the entry** to `REGISTRY_INPUT` in `packages/feature-flags/src/registry.ts`. Match the existing entries' shape and comment style.
5. **Regenerate:**
   ```bash
   node --experimental-transform-types scripts/codegen/gen-feature-flags.mjs
   ```
6. **Wire the call site(s)** — the resolver + variant components from Step 3, or a direct `evaluateFlag`/`getServerFlag`/`useFeatureFlag` call, wherever the flag is actually consumed.
7. **Run the validation gate** (below). Do not stop before every item passes.

---

## Workflow: `update`

1. Locate the entry in `registry.ts`.
2. Apply the change — a new variant, a weight rebalance (must still sum to 100), flipping `experiment.enabled`, a description edit.
3. If a variant KEY was renamed or removed and the flag has a copy-and-suffix resolver: update the resolver's dispatch (`switch`/lookup) to match, and rename/delete the corresponding `.{variant}.tsx` file(s) — never leave a resolver branch pointing at a variant key the registry no longer declares.
4. Regenerate (Step 5 above).
5. Run the validation gate.

---

## Workflow: `remove`

Mirrors `packages/feature-flags/CLAUDE.md` § "Removing a flag" exactly — every step is a **deletion**, never a line-by-line untangling:

1. `grep -rn '<flag-key>'` across `packages/web/src` and `packages/feature-flags/src` to find every consumer.
2. **If it has a copy-and-suffix scaffold:** promote the winning arm's component — either rename its file to the resolver's name and inline its content, or have the resolver import and re-export it directly. Delete the losing arm's file(s). Delete the resolver's dispatch logic (the `switch`/lookup becomes unnecessary once there's only one arm).
3. **If it's a plain `useFeatureFlag`/`getServerFlag` read:** remove the conditional and keep whichever branch won.
4. Delete the entry from `packages/feature-flags/src/registry.ts`.
5. Regenerate (Step 5 of `add`).
6. Run the validation gate.
7. Final sweep: `grep -rn '<flag-key>'` across the whole repo (including `docs/feature-flags.md` if it was used as a documentation example) — nothing should still reference it.

---

## Validation gate (every mode — do not report done without this)

```bash
node --experimental-transform-types scripts/codegen/gen-feature-flags.mjs --check
nx test feature-flags
nx typecheck feature-flags web
nx lint feature-flags web
```

All four must be clean (the lint gate is 0 **errors** — a handful of
pre-existing unrelated warnings elsewhere in `web` is normal and not this
skill's concern; see the root `CLAUDE.md`'s sandbox-baseline notes if a
red result looks suspiciously large and pre-existing).

Add a test alongside the change when it exercises new logic the schema's own
validation doesn't already cover — a new bucketing distribution assumption, a
provider edge case, a new override interaction. A flag addition that's pure
data (fits the existing registry shape exactly) needs no new test; the
freshness spec (`generated-artifacts.spec.ts`) and the schema's own
`superRefine` checks already cover it.

**Never run a whole-repo `nx run-many`/`--all` fan-out for this** — scope to
the two affected projects (`feature-flags`, `web`) exactly as shown above; see
the root `CLAUDE.md` § "Never run whole-repo Nx fan-outs in a cloud sandbox".

---

## Definition of done

- [ ] Mode and target flag key stated up front.
- [ ] `registry.ts` entry matches `FlagDefinitionSchema` (validated at import
      time — an invalid entry throws immediately, so a green test run already
      proves this).
- [ ] Generated files (`flags.generated.ts`, `flags.manifest.json`) regenerated
      and committed alongside the registry change — never drift.
- [ ] UI-variant scaffold used (or explicitly judged unnecessary) per Step 3
      of `add` — not defaulted to inline branching without that judgment call
      being made.
- [ ] The four validation-gate commands all pass.
- [ ] For `remove`: a final repo-wide grep for the flag key returns nothing.
