// GENERATED — do not edit.
// Source: packages/feature-flags/src/registry.ts
// Regenerate: node scripts/codegen/gen-feature-flags.mjs
//
// Edit the registry, not this file. `--check` fails CI when the two disagree.

/** A JSON value — mirrors `schema.ts`'s `JsonValue`, re-declared here to keep this file import-free. */
export type JsonValue = boolean | string | number | null | JsonValue[] | { [key: string]: JsonValue };

/** Every declared flag key. */
export type FlagKey =
  | 'new-onboarding-flow'
  | 'usage-charts-v2'
  | 'cli-completion-engine'
  | 'plan-badge-copy'
  | 'insights-page'
  | 'usage-empty-state-copy'
  | 'retention-policies';

/** Flag key -> its evaluated value type. */
export interface FlagValueMap {
  'new-onboarding-flow': boolean;
  'usage-charts-v2': boolean;
  'cli-completion-engine': boolean;
  'plan-badge-copy': string;
  'insights-page': boolean;
  'usage-empty-state-copy': JsonValue;
  'retention-policies': boolean;
}

/** The value type `evaluateFlag(key, ...)` resolves to for a given key. */
export type FlagValue<K extends FlagKey> = FlagValueMap[K];

/** Every declared flag key, in registry order — for runtime iteration. */
export const FLAG_KEYS: readonly FlagKey[] = [
    "new-onboarding-flow",
    "usage-charts-v2",
    "cli-completion-engine",
    "plan-badge-copy",
    "insights-page",
    "usage-empty-state-copy",
    "retention-policies"
  ];
