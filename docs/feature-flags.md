# Feature Flags & A/B Testing

`@lorekit/feature-flags` (`packages/feature-flags/`) is LoreKit's flag system:
[OpenFeature](https://openfeature.dev/)-standard evaluation, one hand-authored
registry that codegen projects into typed TypeScript bindings and a
language-neutral JSON manifest, and OTel-instrumented A/B testing so an
experiment's conversion impact is a Dash0 query away.

## Why OpenFeature

Every call site evaluates flags through the vendor-neutral OpenFeature API
(`evaluateFlag`, backed by `@openfeature/server-sdk`), never a concrete
provider. Today `LoreKitFlagProvider` resolves flags from the checked-in
registry — there is no remote flag-management backend yet. Swapping in one
later (LaunchDarkly, Flagsmith, GrowthBook, a future LoreKit-hosted service)
means writing a new `Provider` and calling `OpenFeature.setProvider()` with
it; every existing call site is unaffected, because that indirection is
OpenFeature's entire purpose.

## Authoring a flag

Edit `packages/feature-flags/src/registry.ts` — the single source of truth —
then regenerate the derived artifacts:

```bash
node --experimental-transform-types scripts/codegen/gen-feature-flags.mjs
# or, once wired into your shell: nx run feature-flags:generate
```

A flag is:

```ts
{
  key: 'new-onboarding-flow',       // kebab-case
  description: '...',
  type: 'boolean' | 'string' | 'number',
  variants: { control: false, treatment: true },  // variant key -> value
  defaultVariant: 'control',        // returned when there's no active experiment
  experiment: {                     // optional — omit for a plain on/off flag
    enabled: true,
    variants: [
      { key: 'control', weight: 50 },
      { key: 'treatment', weight: 50 },   // weights across all variants must sum to 100
    ],
  },
  owner: '@lorekit/web',            // team/package — for cleanup audits
  tags: ['onboarding', 'experiment'],
}
```

`FlagRegistrySchema` (zod, `src/schema.ts`) validates every entry at import
time: kebab-case keys, `defaultVariant` must be a real variant, variant values
must match the declared `type`, experiment weights must sum to 100, and no
duplicate keys across the registry. An invalid registry throws immediately —
it can never ship a flag that silently resolves to `undefined`.

`nx run feature-flags:check:generate` (and the `generated-artifacts.spec.ts`
vitest guard) fails when the generated files have drifted from the registry —
the same contract `scripts/codegen/gen-surfaces.mjs` uses elsewhere in this
repo.

## Evaluating a flag

```ts
import { evaluateFlag } from '@lorekit/feature-flags';

const showNewOnboarding = await evaluateFlag('new-onboarding-flow', {
  targetingKey: userId, // stable per-user ID — see "Deterministic bucketing" below
});
```

`evaluateFlag('typo-key', ...)` is a **compile error** — the `key` parameter
is typed against the generated `FlagKey` union
(`src/generated/flags.generated.ts`), not a bare `string`. The return type is
inferred too: a `boolean`-typed flag resolves to `Promise<boolean>`.

## Deterministic bucketing (A/B assignment)

`assignExperimentVariant` (`src/bucketing.ts`) hashes
`` `${flagKey}:${targetingKey}` `` with FNV-1a into `[0, 100)` and walks the
experiment's variants by cumulative weight. No RNG, no shared cache, no
database: the same user always lands in the same arm of the same experiment,
in every process, for the life of the experiment — which is the property an
A/B test needs to be meaningful. Pass a **stable** `targetingKey` (a user ID,
not a session ID that changes every visit) or every page view re-randomizes
the assignment and the conversion comparison becomes noise.

## Reading the A/B result back out of Dash0

Every evaluation runs through `featureFlagOtelHook` (`src/otel-hook.ts`), an
OpenFeature [`Hook`](https://openfeature.dev/specification/sections/hooks)
registered once by `getFeatureFlagClient()`. On every `evaluateFlag` call it
stamps the **active span** with:

| Attribute                     | Example               | Notes                                                               |
| ----------------------------- | --------------------- | ------------------------------------------------------------------- |
| `feature_flag.key`            | `new-onboarding-flow` |                                                                     |
| `feature_flag.provider.name`  | `lorekit-flags`       |                                                                     |
| `feature_flag.context.id`     | `user_abc123`         | The `targetingKey`, when the evaluation context carries one         |
| `feature_flag.result.variant` | `treatment`           | **This is the A/B dimension** — filter or group by it               |
| `feature_flag.result.reason`  | `SPLIT`               | `SPLIT` = experiment bucketing ran; `STATIC` = no active experiment |

...plus a `feature_flag.evaluation` span event carrying the same data (so a
trace that evaluates several flags still shows each one on the timeline), and
a `lorekit.feature_flag.evaluations` counter dimensioned by
`feature_flag.key` + `feature_flag.result.variant`.

Attribute names follow the OTel
[feature-flag semantic conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/feature-flag/)
(currently "incubating" in the spec — not yet exported by the pinned
`@opentelemetry/semantic-conventions` version, so they're declared as plain
string constants in `src/otel-attributes.ts` rather than an extra dependency).

### Span attribute, not Resource attribute — on purpose

A `Resource` describes _the process_ (service name, version, host) and is
fixed for the life of one SDK instance. An A/B variant is decided **per
evaluation** — per request, per user — inside one long-lived server process
that serves every arm of the experiment at once, so it cannot be a
process-wide Resource attribute without running one process per variant.
Carrying it as a **span attribute** on every request's active span (and, by
extension, any log or metric emitted in that request's context) is the
correct place for a per-request fact — and it is exactly what "does treatment
convert better than control" needs: filter every span in a user's request
(sign-up, checkout, error spans, whatever the experiment cares about) by
`feature_flag.result.variant` and compare outcome rates between arms.

### Example query

Compare evaluation volume per variant (Dash0 PromQL, using the
`lorekit.feature_flag.evaluations` counter):

```promql
sum by (feature_flag_result_variant) (
  rate(lorekit_feature_flag_evaluations_total{feature_flag_key="new-onboarding-flow"}[1h])
)
```

To measure _conversion_, correlate the same `feature_flag.result.variant`
value against whatever span or event marks conversion in your product (a
`checkout.completed` span, a RUM event — see the
[`measurable`](https://github.com/mthines/agent-skills/blob/main/skills/quality/measurable/SKILL.md)
skill's guidance on RUM/OTel signal design) using Dash0's span/log search:
filter to spans with `feature_flag.result.variant = "treatment"` vs
`"control"` within the same trace or session, and compare the rate at which
each population reaches the conversion span.

## Cross-language flags (adding a language)

Nothing above is TypeScript-specific in its _data_. `generated/flags.manifest.json`
is the language-neutral projection of the registry:

```json
{
  "flags": [
    {
      "key": "new-onboarding-flow",
      "type": "boolean",
      "variants": { "control": false, "treatment": true },
      "defaultVariant": "control",
      "experiment": { "enabled": true, "variants": [ ... ] },
      "owner": "@lorekit/web",
      "tags": ["onboarding", "experiment", "web"]
    }
  ]
}
```

A generator for another language reads this file and emits that language's
typed bindings, the same way `gen-feature-flags.mjs` emits
`flags.generated.ts` for TypeScript:

1. Read `packages/feature-flags/generated/flags.manifest.json`.
2. Emit a typed constant/enum per `flags[].key` in that language's idiom
   (a Go `const`, a Python `Enum`, a Rust `enum`).
3. Implement or reuse that language's OpenFeature SDK
   ([full list](https://openfeature.dev/ecosystem?instant_search%5BrefinementList%5D%5Btype%5D%5B0%5D=SDK)),
   pointed at whatever serves flags to that runtime (for a same-process
   service, port `LoreKitFlagProvider`'s resolution logic — static lookup +
   `assignExperimentVariant`'s FNV-1a bucketing — from `src/provider.ts` /
   `src/bucketing.ts`; for a separate service, evaluate through the TS
   service instead and skip re-implementing resolution).
4. Apply the OTel feature-flag semantic-convention attribute names from
   [the "Reading the A/B result" section](#reading-the-ab-result-back-out-of-dash0)
   above on that language's active span, so the Dash0 query above works
   identically regardless of which language evaluated the flag.

No language-specific generator exists in this repo yet — add one under
`scripts/codegen/` (e.g. `gen-feature-flags-go.mjs`) when a non-TS consumer
needs flags, following `gen-feature-flags.mjs`'s `--check`-guarded,
pure-render-function shape.

## Removing a flag

Delete its entry from `registry.ts`, regenerate, and grep the repo for the
key — `FLAG_KEYS` (from `src/generated/flags.generated.ts`) is the
authoritative list to diff a removal against. There is no automatic
stale-flag detection yet; `owner` + `tags` on each definition exist so a
future audit script (or a manual sweep) has enough to go on.
