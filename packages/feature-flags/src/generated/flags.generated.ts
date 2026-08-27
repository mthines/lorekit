// GENERATED — do not edit.
// Source: packages/feature-flags/src/registry.ts
// Regenerate: node scripts/codegen/gen-feature-flags.mjs
//
// Edit the registry, not this file. `--check` fails CI when the two disagree.

/** Every declared flag key. */
export type FlagKey =
  | 'new-onboarding-flow'
  | 'usage-charts-v2'
  | 'cli-completion-engine';

/** Flag key -> its evaluated value type. */
export interface FlagValueMap {
  'new-onboarding-flow': boolean;
  'usage-charts-v2': boolean;
  'cli-completion-engine': boolean;
}

/** The value type `evaluateFlag(key, ...)` resolves to for a given key. */
export type FlagValue<K extends FlagKey> = FlagValueMap[K];

/** Every declared flag key, in registry order — for runtime iteration. */
export const FLAG_KEYS: readonly FlagKey[] = [
    "new-onboarding-flow",
    "usage-charts-v2",
    "cli-completion-engine"
  ];
