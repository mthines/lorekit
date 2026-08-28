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
  type: 'boolean' | 'string' | 'number' | 'object',
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

### Value types

All four types OpenFeature's own evaluation API distinguishes are supported —
this isn't a subset:

| `type` | Variant value | Example |
|--------|---------------|---------|
| `boolean` | `true` / `false` | `new-onboarding-flow` |
| `string` | any string | `plan-badge-copy` — `{ beta: 'Beta', earlyAccess: 'Early Access' }` |
| `number` | any number | — |
| `object` | any JSON value (nested objects/arrays included) | `usage-empty-state-copy` — a whole `{ title, ctaLabel, ctaHref }` copy block per variant |

`object` accepts the full recursive JSON value space (`schema.ts`'s
`JsonValue` type — booleans, strings, numbers, `null`, arrays, and nested
objects), not a flat key-value bag — a variant can be an arbitrarily
structured config. `evaluateFlag('usage-empty-state-copy')` returns the whole
resolved object, typed via the generated `FlagValueMap` (see
`flags.generated.ts`'s `JsonValue` type when at least one flag uses it).

There is deliberately no per-flag TypeScript shape for an `object` flag's
contents beyond `JsonValue` — the registry has no mechanism to declare "this
object flag's variants are always `{ title: string; ctaLabel: string }`"
today. If a consumer needs that, narrow it at the call site
(`evaluateFlag('usage-empty-state-copy') as { title: string; ctaLabel: string; ctaHref: string }`)
or treat adding a per-flag payload schema as a follow-up to this codegen —
`FlagDefinitionSchema` already has everywhere such a schema would plug in
(next to `type`).

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

## Feature flags in telemetry

Two, DIFFERENT mechanisms carry flag state into Dash0 — one per evaluation,
on a server-side span; one per session, on every RUM signal a browser sends.
Reach for the wrong one and a query returns nothing: a span search finds a
single evaluation, never "was this flag on for this visitor's whole session,"
and a Web Events search finds session-wide RUM tags, never a single
server-side evaluation's outcome.

| Question | Signal | Mechanism |
|---|---|---|
| "What did THIS evaluation resolve to?" (debugging one request/render) | Server-side span | `featureFlagOtelHook` — below |
| "Which flags were active for THIS visitor, across their whole session — and did they convert?" | Web Events / RUM | `syncFeatureFlagRumAttributes` — further down |

### Server-side spans

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

#### Span attribute, not Resource attribute — on purpose

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

#### Example query

Compare evaluation volume per variant (Dash0 PromQL, using the
`lorekit.feature_flag.evaluations` counter):

```promql
sum by (feature_flag_result_variant) (
  rate(lorekit_feature_flag_evaluations_total{feature_flag_key="new-onboarding-flow"}[1h])
)
```

This tells you evaluation VOLUME per variant — useful for confirming the
split is roughly even — but not conversion. For conversion, use the Web
Events mechanism below: it's the one built for "did the visitors who saw
variant X do the thing" questions.

### Web Events / RUM — retrospective, per-visitor flag state

`FeatureFlagsProvider` (`components/providers/FeatureFlagsProvider.tsx`) calls
`syncFeatureFlagRumAttributes` (`lib/dash0-rum.ts`) on mount and whenever the
server re-evaluates flags (a session override change, a navigation). It uses
`@dash0/sdk-web`'s `addSignalAttribute`, which attaches to **every subsequent
signal the browser SDK emits** — page views, clicks, custom events, errors —
for the rest of the session:

| Attribute | Example | Notes |
|-----------|---------|-------|
| `feature_flag.<flagKey>` | `feature_flag.new-onboarding-flow = "treatment"` | One dynamically-named attribute PER FLAG, holding its variant |

This is a genuinely different shape from the server-side span attributes
above, on purpose: the OTel feature-flag semantic conventions
(`feature_flag.key` + `feature_flag.result.variant`) describe ONE evaluation,
but a RUM session has MANY flags active simultaneously (every flag in the
registry). Reusing the same fixed attribute names for all of them would mean
each flag overwrites the last one under an identical key — there is no
OTel-standard shape for "here is the whole set of concurrently active flags."
`feature_flag.<flagKey>` as a per-flag attribute NAME is the one
representation that doesn't collide, at the cost of not being spec-standard.
Only the variant is attached, never an `object`-typed flag's whole payload —
same "prefer `variant` over `value`" reasoning as the span hook.

**This is what answers "did treatment convert better than control":** search
or group Web Events by `feature_flag.new-onboarding-flow`, and compare
whatever conversion event you're tracking (a `sign_up_completed` custom event,
a specific page reached) between the `"control"` and `"treatment"`
populations.

**Before this was wired (nothing appears):** if you evaluated flags server-
side (Server Components) before `FeatureFlagsProvider` existed on this
codebase, or before a page ever finished a client-side hydration where the
provider mounts, no `feature_flag.*` attribute reaches RUM at all — only the
server-side span hook fires. A `feature_flag.*` search on Web Events finding
nothing is the correct, expected symptom of that gap, not a broken query.

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

## `packages/web` integration

The dashboard reads flags on **both** the server and the client, from exactly
one evaluation per request — there is no independent client-side bucketing.

**Server-side** (Server Components, Server Actions, Route Handlers):

```tsx
import { getServerFlag } from '@/lib/feature-flags/server';

export default async function SomePage() {
  const showTreatment = await getServerFlag('new-onboarding-flow');
  return showTreatment ? <NewOnboarding /> : <LegacyOnboarding />;
}
```

**Client-side** (any Client Component under the dashboard layout):

```tsx
'use client';
import { useFeatureFlag } from '@/components/providers/FeatureFlagsProvider';

function SomeWidget() {
  const showTreatment = useFeatureFlag('new-onboarding-flow');
  return showTreatment ? <NewWidget /> : <LegacyWidget />;
}
```

### Why the client hook doesn't evaluate independently

`@openfeature/server-sdk` cannot run in the browser — it's Node-only.
OpenFeature ships a separate `@openfeature/web-sdk` for that, which this app
does not depend on. Rather than add a second SDK and a second bucketing code
path (and risk it disagreeing with the server's evaluation and causing a
hydration mismatch), the dashboard layout (`app/(dashboard)/layout.tsx`) calls
`getAllServerFlagState()` once per request and seeds `FeatureFlagsProvider`, a
React context, with the resolved values (and variants — see below).
`useFeatureFlag` is a plain context read — no fetch, no loading state, and
structurally unable to disagree with whatever the server rendered, because
it's reading the same server's answer.

The trade-off: a flag's value is fixed for the lifetime of the current page's
RSC payload. Changing it (via the developer overrides page, below) needs a
fresh server render (`revalidatePath`), not a client-side re-evaluation.

### Targeting key resolution

`resolveFeatureFlagContext()` (`lib/feature-flags/server.ts`) builds the
`targetingKey` as: the authenticated Supabase user id when signed in, else a
stable per-browser id read from an **httpOnly** cookie
(`lorekit_flag_anon_id`, minted once by `middleware.ts` for every visitor).
This closes the gap in `LoreKitFlagProvider`'s own fallback — an experiment
evaluated with no `targetingKey` at all buckets every caller onto the same
constant, which is not a split — by guaranteeing the web app always supplies
a real one, even before sign-in.

### UI variants: copy-and-suffix, never inline branching

When a flag changes what renders — not just a boolean read gating one small
prop — put each arm in its OWN component, in its OWN file, and dispatch
between them from one small resolver. Never grow a single component with
`if (flag) { ... } else { ... }` branches threaded through its JSX and logic.

**Naming convention:**

```
OnboardingPreview.tsx              ← the resolver — the only file everything else imports
OnboardingPreview.control.tsx      ← one arm, a whole standalone component
OnboardingPreview.treatment.tsx    ← the other arm, equally standalone
```

The suffix is the flag's **variant key** — not a hardcoded "a"/"b" — so it
reads the same regardless of how a given flag names its arms (`control`/
`treatment`, `off`/`on`, `beta`/`earlyAccess`, ...).

**The resolver** dispatches on the variant KEY via
{@link useFeatureFlagVariant} (server-side: `evaluateFlagDetails(key,
context).variant` — see `getAllServerFlagState()` in `server.ts`), never on
the flag's raw VALUE — a value tells you `true`/`false`, not which arm to
render, and doesn't generalise past two variants:

```tsx
'use client';
import { useFeatureFlagVariant } from '@/components/providers/FeatureFlagsProvider';
import { OnboardingPreviewControl } from './OnboardingPreview.control';
import { OnboardingPreviewTreatment } from './OnboardingPreview.treatment';

export function OnboardingPreview() {
  const variant = useFeatureFlagVariant('new-onboarding-flow');
  switch (variant) {
    case 'treatment':
      return <OnboardingPreviewTreatment />;
    case 'control':
    default:
      return <OnboardingPreviewControl />;
  }
}
```

A real, working instance of exactly this trio lives at
`packages/web/src/components/dashboard/onboarding-preview/` — rendered live
on `/settings/developer` so toggling the flag's override visibly swaps the
two components. It previews `new-onboarding-flow`; it is not (yet) wired into
the actual onboarding flow — a worked example for the pattern, not a redesign.

**Why this is worth the extra files:** the entire point is what happens when
the experiment ENDS. With two standalone components, shipping the winner is:

1. Promote the winning file's content into the resolver's filename (or just
   have the resolver import and re-export it directly).
2. Delete the losing variant's file.
3. Delete the resolver's `switch`/dispatch logic.
4. Remove the flag from `registry.ts` and regenerate.

Every step is a **deletion**, never a diff into shared logic to untangle.
Compare to the inline-branch alternative: after months of small edits to both
sides of an `if`, the two branches are no longer clean opposites — shared
state, interleaved hooks, a bugfix applied to one arm and not the other — and
"remove the losing variant" becomes "carefully read every line of this
component to figure out what's actually reachable now."

**When this doesn't apply:** a flag that gates one small prop or a single CSS
class (`usage-charts-v2` deciding which chart-rendering call to make inside
an otherwise-identical page) doesn't need two whole components — use
`useFeatureFlag`/`getServerFlag` directly, per the plain examples above. Reach
for copy-and-suffix specifically when an experiment's arms diverge enough
that keeping them in one file means real branching logic, not a single ternary.

## Session overrides

The developer/admin override page — `/settings/developer`, source in
`app/(dashboard)/settings/developer/` — lets you force a specific variant for
your own session, for **both** the server and the client, resettable per flag
or all at once.

### How it works

An **httpOnly** cookie (`lorekit_flag_overrides`, `packages/web/src/lib/feature-flags/overrides-cookie.ts`)
holds a JSON map of `flagKey -> variantKey`. The Server Actions in
`overrides-actions.ts` (`setFlagOverrideAction` / `clearFlagOverrideAction` /
`clearAllFlagOverridesAction`) write it, validating every entry against the
live `FLAG_REGISTRY` through `@lorekit/feature-flags`' `parseFlagOverrides`
(a stale or hand-edited cookie value is silently dropped, never trusted).
`resolveFeatureFlagContext()` reads the cookie on every request and folds it
into the `EvaluationContext` via `withFlagOverrides`; `LoreKitFlagProvider`
checks it FIRST, before static/experiment resolution, and reports
`reason: 'OVERRIDE'`.

Because there is exactly one evaluation site (server-side — see above), the
override reaches the client automatically: after a Server Action mutates the
cookie, it calls `revalidatePath('/', 'layout')`, the dashboard layout
re-evaluates every flag, and `FeatureFlagsProvider` re-renders with the new
values. No separate cookie read on the client, no separate apply step for
`useFeatureFlag` — it's the same one context, freshly seeded.

### Why not Vercel Toolbar / the `flags` SDK

Vercel's `flags` SDK (formerly `@vercel/flags`) is a reasonable choice in
general, but wasn't adopted here for three reasons specific to this app:

1. **A second evaluation model, on top of OpenFeature.** The `flags` SDK
   wants a `decide()` function per flag and largely displaces the provider
   abstraction OpenFeature already gives this repo cross-language portability
   through (see "Why OpenFeature" above). Using both means either running
   two systems side by side or making `flags` the *only* layer and reducing
   `LoreKitFlagProvider` to a `decide()` implementation detail — a bigger
   redesign than a settings page.
2. **The Toolbar needs a discovery route and override-cookie plumbing this
   app would still have to write** (`/.well-known/vercel/flags`, encrypted
   override cookies, `verifyAccess`) — comparable effort to the Settings page
   built instead, but tied to Vercel's toolbar UI and cookie format rather
   than this app's own Settings surface, session model, and design system.
3. **This repo already has an authenticated, styled settings area** with the
   exact plumbing an override needs (cookies via `next/headers`, Server
   Actions, `revalidatePath`). Building the override page as one more
   `SectionPanel` reuses all of it — no new auth surface, no new UI system,
   no dependency on the Vercel platform (the toolbar is Vercel-hosted
   tooling; this runs identically in local dev, preview, and self-hosted-off-
   Vercel scenarios, which matters for a project not permanently committed to
   one host).

The trade-off, accepted deliberately: no visual "which variant am I seeing"
overlay in the deployed preview the way the Vercel Toolbar draws one. The
Settings page shows the same information (current value, variant, reason)
in a table instead of an overlay.

### Access in production: an email allowlist, plus a reveal gesture for the nav

Outside production, `/settings/developer` is reachable by any signed-in
user — an override cookie only ever changes what **the browser holding it**
sees, so there's no cross-user risk an org-role gate would need to mitigate,
and gating on environment alone keeps dev/preview frictionless.

In production, that's the wrong bar: a customer should never reach
flag-override tooling at all. Two independent pieces enforce and surface
that:

1. **The real access-control boundary — `notFound()` on the page itself**
   (`app/(dashboard)/settings/developer/page.tsx`). Outside production: no
   check. In production: the signed-in user's email must be in
   `DEVELOPER_EMAILS` (`packages/web/src/lib/developer-users.ts`, a small
   hand-maintained allowlist), or the page 404s. This runs on every request
   to the URL directly — it is NOT conditional on the reveal gesture below,
   so a bookmarked link keeps working for a developer across reloads.
2. **The nav-link visibility toggle — a "5 clicks in a row" gesture, purely
   cosmetic.** `SettingsNav.tsx` only shows the "Developer" nav item in
   production when `isDeveloperEmail(userEmail)` is true **and** a
   client-only, `localStorage`-backed toggle (`useDeveloperNavRevealed` —
   `lib/hooks/useDeveloperNavRevealed.ts`) is on. That toggle is flipped by
   clicking the avatar on `/settings/user` (`UserSettingsPanel.tsx`) 5 times
   within 2 seconds of each other (the counting rule is pure and unit-tested:
   `lib/click-gesture.ts`) — 5 more clicks flips it off again, so a developer
   can hide the nav entry before a screenshot or a demo and bring it back
   after. The click handler does nothing at all for anyone whose email isn't
   allowlisted; there's no visual affordance on the avatar either — this is
   a secret gesture for a developer who already knows about it, not a
   discoverable control.

The reason these are two separate mechanisms rather than one: a gesture
persisted in `localStorage` is exactly the kind of state that shouldn't ALSO
gate the page load (a cleared browser profile or a fresh device would lock
a real developer out of a bookmarked link), and a page-level check is exactly
the kind of thing that shouldn't be the UX control for "don't show this in my
screenshot" (reloading the page to re-check a cookie is a worse interaction
than a local toggle). The email allowlist is small and hand-edited on
purpose — add an email to `DEVELOPER_EMAILS` to grant access; there is no
self-service enrolment.

If a future flag ever gates something security-sensitive (not the pattern
today — every flag here is a UI/rollout switch), reconsider stricter gating
for that specific flag rather than this page's access model as a whole.

## Removing a flag

Delete its entry from `registry.ts`, regenerate, and grep the repo for the
key — `FLAG_KEYS` (from `src/generated/flags.generated.ts`) is the
authoritative list to diff a removal against. There is no automatic
stale-flag detection yet; `owner` + `tags` on each definition exist so a
future audit script (or a manual sweep) has enough to go on.
