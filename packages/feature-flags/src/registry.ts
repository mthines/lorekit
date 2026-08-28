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

const REGISTRY_INPUT = [
  {
    key: 'new-onboarding-flow',
    description:
      'Redesigned first-run onboarding wizard for the web dashboard, vs the current three-step flow.',
    type: 'boolean',
    variants: { control: false, treatment: true },
    defaultVariant: 'control',
    experiment: {
      enabled: true,
      variants: [
        {
          key: 'control',
          description: 'Existing three-step onboarding.',
          weight: 50,
        },
        {
          key: 'treatment',
          description: 'New single-page onboarding wizard.',
          weight: 50,
        },
      ],
    },
    owner: '@lorekit/web',
    tags: ['onboarding', 'experiment', 'web'],
  },
  {
    key: 'usage-charts-v2',
    description: 'New usage-chart rendering pipeline on the dashboard Usage page.',
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/web',
    tags: ['dashboard', 'web'],
  },
  {
    key: 'cli-completion-engine',
    description: 'Enables the rewritten zsh/fish completion generator in `lorekit completion`.',
    type: 'boolean',
    variants: { off: false, on: true },
    defaultVariant: 'off',
    owner: '@lorekit/cli',
    tags: ['cli'],
  },
  {
    key: 'plan-badge-copy',
    description: 'The plan badge label shown at the top of Settings → Plan, during the beta.',
    // `type: 'string'` — proves the string-valued path end to end (schema,
    // codegen, provider, evaluateFlag); every other flag here is boolean.
    type: 'string',
    variants: { beta: 'Beta', earlyAccess: 'Early Access' },
    defaultVariant: 'beta',
    owner: '@lorekit/web',
    tags: ['dashboard', 'copy'],
  },
  {
    key: 'usage-empty-state-copy',
    description:
      'Object-valued flag: the title/CTA copy block shown on the dashboard Usage page for an account with no data yet.',
    // `type: 'object'` — proves the object-valued path (an arbitrary JSON
    // structure per variant, not just a primitive) end to end.
    type: 'object',
    variants: {
      default: { title: 'No usage yet', ctaLabel: 'Learn more', ctaHref: '/docs/limits' },
      playful: {
        title: "It's quiet in here…",
        ctaLabel: 'See what counts',
        ctaHref: '/docs/limits',
      },
    },
    defaultVariant: 'default',
    owner: '@lorekit/web',
    tags: ['dashboard', 'copy'],
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
