/**
 * The flag registry — the single, hand-authored source of truth.
 *
 * Add or change a flag HERE, then regenerate the derived artifacts:
 *
 *   nx run feature-flags:generate
 *
 * `nx run feature-flags:check:generate` fails CI when the generated files
 * (`src/generated/flags.generated.ts`, `generated/flags.manifest.json`) have
 * drifted from this file — the same `--check` contract as
 * `scripts/codegen/gen-surfaces.mjs`.
 *
 * Note on import extensions: this package's internal relative imports use
 * literal `.ts` extensions (not the `.js`-referring-to-`.ts` convention used
 * elsewhere in the monorepo, e.g. `packages/mcp-core`). `gen-feature-flags.mjs`
 * `import()`s this file directly under plain Node (no bundler, no `tsx`), and
 * plain Node's ESM resolver does not remap `.js` specifiers onto `.ts` files —
 * only bundler-style resolvers (Vite/Vitest, tsc's nodenext) do that. `.ts`
 * extensions resolve identically under Node, tsc (`allowImportingTsExtensions`
 * is set in this package's `tsconfig.json`), and Vitest, so it is the one
 * extension style that works everywhere this package is actually loaded from.
 *
 * `FLAG_REGISTRY` is validated against `FlagRegistrySchema` at import time
 * (see the `parseRegistry` call below) — an invalid entry (bad key casing,
 * `defaultVariant` not in `variants`, experiment weights that don't sum to
 * 100, a variant value of the wrong `type`) throws immediately rather than
 * shipping a flag that resolves to `undefined` at runtime.
 */
import { FlagRegistrySchema, type FlagDefinition } from './schema.ts';

/**
 * Every entry here must gate something real. This file shipped with five
 * demonstration flags alongside the two live ones — an A/B experiment
 * (`new-onboarding-flow`) whose only consumer was a preview widget on
 * `/settings/developer`, two toggles nothing read (`usage-charts-v2`,
 * `cli-completion-engine`), and two that existed to exercise the non-boolean
 * value paths (`plan-badge-copy` for `string`, `usage-empty-state-copy` for
 * `object`). They have been removed.
 *
 * The machinery they demonstrated is unchanged and still fully covered — just
 * at the layer that can test it without a production flag standing in as a
 * fixture. `provider.spec.ts` declares its own `FlagDefinition`s and exercises
 * all four value types, the weighted experiment split and the override path
 * against them; `bucketing.spec.ts` covers the FNV-1a assignment directly. So
 * do NOT re-add a flag "so the string/object/experiment path has an example":
 * a registry entry is a live product decision, and one that gates nothing is
 * indistinguishable at a call site from one that was left behind after a
 * rollout finished.
 */
const REGISTRY_INPUT = [
  {
    key: 'insights-page',
    description:
      'The consolidated /insights dashboard page (usage health, agent breakdown, scope consumption, hot/cold lore, runs) — gates the page itself (404 when off), its sidebar nav item, and its command-palette entry.',
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: ['dashboard', 'web', 'rollout'],
  },
  {
    key: 'retention-policies',
    description:
      'Settings → Grooming — retention policies that auto-archive stale lore, plus its sidebar nav entry, and the Lore Explorer’s retention-preview conditions. Gates the dashboard UI ONLY, and it is now the single gate: the MCP/REST surface (policy.*, groom.*, memory.protect) is enabled unconditionally. It used to carry a second, independent backend gate (`LOREKIT_RETENTION_POLICIES_ENABLED`, a Supabase secret) — removed, because it never gated visibility (`tools/list` advertised the tools either way) and was unset in every environment, so its only effect was an advertised tool that always failed. Flipping this flag on is therefore a UI decision with no backend prerequisite.',
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: ['dashboard', 'web', 'rollout'],
  },
  {
    key: 'lore-explorer-instruments',
    description:
      "Lore Explorer \u2014 the collapsible instrument panel above the memory list (matrix and timeline). An instrument is a filter INPUT, not a view: every selection it makes is written to the same `?filters=` bar the menu writes, so the list below stays the single output. Gates only the panel; with it off `/lore` renders exactly as before. The matrix reads `POST /memories/pivot` (migration 00090), which ships unconditionally \u2014 the route is additive and safe to serve whether or not this is on.",
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: ['dashboard', 'web', 'lore-explorer', 'rollout'],
  },
  {
    key: 'lore-explorer-duplicate-clusters',
    description:
      "Lore Explorer — the collapsible Duplicate Clusters panel: groups of near-duplicate lessons in the selected scope, ranked as merge candidates. READ-ONLY, and there is no write counterpart to gate: deciding that N near-duplicates are one lesson is a human judgment, so the panel surfaces the evidence and stops. Gates only the panel; with it off `/lore` renders exactly as before AND issues no clustering request, because the panel is the route's only caller. `GET /memories/clusters` itself ships unconditionally — it is additive, read-only and safe to serve whether or not this is on, the same call `lore-explorer-instruments` makes about `POST /memories/pivot`.",
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: ['dashboard', 'web', 'lore-explorer', 'rollout'],
  },
] satisfies unknown[];

function parseRegistry(input: unknown): readonly FlagDefinition[] {
  const result = FlagRegistrySchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `Invalid @lorekit/feature-flags registry:\n${result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
  }
  return result.data;
}

/** The validated, canonical set of flags. Import this — never `REGISTRY_INPUT`. */
export const FLAG_REGISTRY: readonly FlagDefinition[] = parseRegistry(REGISTRY_INPUT);

export function getFlagDefinition(key: string): FlagDefinition | undefined {
  return FLAG_REGISTRY.find((f) => f.key === key);
}
