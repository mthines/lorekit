/**
 * @lorekit/feature-flags — OpenFeature-backed flags with cross-language
 * codegen and OTel-instrumented A/B testing.
 *
 * Call sites should only ever need:
 *
 *   import { evaluateFlag } from '@lorekit/feature-flags';
 *   const showNewOnboarding = await evaluateFlag('new-onboarding-flow', {
 *     targetingKey: userId,
 *   });
 *
 * See `docs/feature-flags.md` for the full guide (authoring a flag, running
 * codegen, reading the A/B split back out of Dash0).
 */
export {
  evaluateFlag,
  evaluateFlagDetails,
  getFeatureFlagClient,
  resetFeatureFlagClientForTests,
} from './client.ts';
export { LoreKitFlagProvider } from './provider.ts';
export { featureFlagOtelHook } from './otel-hook.ts';
export { assignExperimentVariant, bucketOf, fnv1aHash } from './bucketing.ts';
export { FLAG_REGISTRY, getFlagDefinition } from './registry.ts';
export {
  FLAG_OVERRIDES_CONTEXT_KEY,
  OVERRIDE_REASON,
  parseFlagOverrides,
  serializeFlagOverrides,
  withFlagOverrides,
  type FlagOverrideContext,
  type FlagOverrides,
} from './overrides.ts';
export {
  FlagDefinitionSchema,
  FlagRegistrySchema,
  ExperimentSchema,
  ExperimentVariantSchema,
  FlagTypeSchema,
  type FlagDefinition,
  type FlagType,
  type Experiment,
  type ExperimentVariant,
} from './schema.ts';
export {
  ATTR_FEATURE_FLAG_KEY,
  ATTR_FEATURE_FLAG_PROVIDER_NAME,
  ATTR_FEATURE_FLAG_CONTEXT_ID,
  ATTR_FEATURE_FLAG_RESULT_VARIANT,
  ATTR_FEATURE_FLAG_RESULT_REASON,
  EVENT_FEATURE_FLAG_EVALUATION,
  METRIC_FEATURE_FLAG_EVALUATIONS,
} from './otel-attributes.ts';
export type { FlagKey, FlagValue, FlagValueMap } from './generated/flags.generated.ts';
export { FLAG_KEYS } from './generated/flags.generated.ts';
