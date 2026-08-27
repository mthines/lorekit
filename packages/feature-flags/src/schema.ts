/**
 * The flag-definition schema — the single source of truth every codegen
 * target (TypeScript today, any other language tomorrow) is derived from.
 *
 * A definition is data, not code, on purpose: `scripts/codegen/gen-feature-flags.mjs`
 * `import()`s `registry.ts`, validates every entry against `FlagDefinitionSchema`,
 * and projects it into (1) `src/generated/flags.generated.ts` — typed keys +
 * per-flag value types the TS client is built on — and (2) `generated/flags.manifest.json`
 * — a language-neutral manifest a Go/Python/Rust generator can read without ever
 * importing TypeScript. Keeping the language-specific client OUT of the schema
 * is what makes the second target possible: nothing here assumes a JS runtime.
 */
import { z } from 'zod';

/** Kebab-case, so a flag key is a legal identifier in every target language's naming convention. */
const FLAG_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

export const FlagTypeSchema = z.enum(['boolean', 'string', 'number']);
export type FlagType = z.infer<typeof FlagTypeSchema>;

/** One arm of an experiment. `weight` values across all variants must sum to 100. */
export const ExperimentVariantSchema = z.object({
  key: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().min(0).max(100),
});
export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>;

/**
 * A/B (or A/B/n) rollout config. `enabled: false` keeps the arms declared —
 * so the experiment can be re-launched without re-authoring — while every
 * evaluation resolves to `defaultVariant` (`reason: STATIC`, no OTel
 * `feature_flag.result.variant` bucketing noise from a dark experiment).
 */
export const ExperimentSchema = z
  .object({
    enabled: z.boolean().default(false),
    variants: z.array(ExperimentVariantSchema).min(2),
  })
  .superRefine((experiment, ctx) => {
    const total = experiment.variants.reduce((sum, v) => sum + v.weight, 0);
    if (Math.abs(total - 100) > 0.001) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `experiment.variants weights must sum to 100, got ${total}`,
      });
    }
    const keys = experiment.variants.map((v) => v.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'experiment.variants keys must be unique',
      });
    }
  });
export type Experiment = z.infer<typeof ExperimentSchema>;

const jsonValue: z.ZodType<boolean | string | number> = z.union([
  z.boolean(),
  z.string(),
  z.number(),
]);

export const FlagDefinitionSchema = z
  .object({
    key: z
      .string()
      .regex(FLAG_KEY_PATTERN, 'flag key must be kebab-case (e.g. "new-onboarding-flow")'),
    description: z.string().min(1),
    type: FlagTypeSchema,
    /** Variant key -> the value returned for that variant. Must include `defaultVariant`. */
    variants: z.record(z.string(), jsonValue),
    defaultVariant: z.string().min(1),
    /** Optional A/B(/n) experiment. Every `experiment.variants[].key` must exist in `variants`. */
    experiment: ExperimentSchema.optional(),
    /** Team or package that owns the flag — surfaced in the manifest for cleanup audits. */
    owner: z.string().min(1),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((def, ctx) => {
    if (!(def.defaultVariant in def.variants)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultVariant'],
        message: `defaultVariant "${def.defaultVariant}" is not a key of variants`,
      });
    }
    for (const variant of def.experiment?.variants ?? []) {
      if (!(variant.key in def.variants)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['experiment', 'variants'],
          message: `experiment variant "${variant.key}" is not a key of variants`,
        });
      }
    }
    const values = Object.values(def.variants);
    const wrongType = values.find((v) => typeof v !== def.type);
    if (wrongType !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['variants'],
        message: `all variant values must be of declared type "${def.type}"`,
      });
    }
  });
export type FlagDefinition = z.infer<typeof FlagDefinitionSchema>;

export const FlagRegistrySchema = z.array(FlagDefinitionSchema).superRefine((defs, ctx) => {
  const keys = defs.map((d) => d.key);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `duplicate flag keys: ${[...new Set(dupes)].join(', ')}`,
    });
  }
});
