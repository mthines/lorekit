/**
 * `LoreKitFlagProvider` — the OpenFeature `Provider` implementation backed by
 * `FLAG_REGISTRY` (see `registry.ts`).
 *
 * There is no remote flag-management service behind this: the registry
 * IS the config, checked into source and shipped with the code that reads
 * it. That is a deliberate scope cut for this first slice — swapping in a
 * remote provider (LaunchDarkly, Flagsmith, GrowthBook, ...) later means
 * writing another `Provider` and calling `OpenFeature.setProvider()` with it;
 * every call site that went through `getFeatureFlagClient()` /
 * `evaluateFlag()` in `client.ts` is unaffected, because OpenFeature's whole
 * point is that application code never imports a provider directly.
 */
import type {
  EvaluationContext,
  JsonValue,
  Logger,
  Provider,
  ResolutionDetails,
  ResolutionReason,
} from '@openfeature/server-sdk';
import { ErrorCode, StandardResolutionReasons } from '@openfeature/server-sdk';
import { assignExperimentVariant } from './bucketing.ts';
import { OVERRIDE_REASON, type FlagOverrideContext } from './overrides.ts';
import { FLAG_REGISTRY } from './registry.ts';
import type { FlagDefinition, FlagType } from './schema.ts';

/**
 * Fallback targeting key when a caller evaluates an experiment flag with no
 * `context.targetingKey` at all.
 *
 * This is a LAST RESORT, not a design a web caller should ever hit: every
 * anonymous request bucketing on this literal constant means every anonymous
 * visitor gets the SAME variant forever, which defeats the entire point of an
 * A/B experiment (100% of anonymous traffic on one arm, not a split). It
 * exists so a caller with genuinely no identity available (a one-off CLI
 * script, a test) still gets a deterministic, reproducible answer instead of
 * a crash — it must never be reached from `packages/web`, which always
 * supplies a real `targetingKey` (the authenticated user id, or a stable
 * per-browser anonymous id — see `packages/web/src/lib/feature-flags/`).
 * `resolveFromDefinition` warns (once per process, dev-only) whenever an
 * active experiment actually falls back to it, so a missing integration is
 * loud instead of silently wrong.
 */
const ANONYMOUS_TARGETING_KEY = 'anonymous';

const warnedFlags = new Set<string>();

function isDev(): boolean {
  return typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
}

function warnMissingTargetingKeyOnce(flagKey: string): void {
  if (!isDev() || warnedFlags.has(flagKey)) return;
  warnedFlags.add(flagKey);
  // eslint-disable-next-line no-console -- intentional one-time dev warning, not telemetry
  console.warn(
    `[@lorekit/feature-flags] "${flagKey}" is an active experiment but was evaluated with no ` +
      `context.targetingKey — every such call gets the SAME variant, which is not an A/B split. ` +
      'Pass a stable per-user or per-visitor id.',
  );
}

function resolveFromDefinition<T extends JsonValue>(
  def: FlagDefinition,
  defaultValue: T,
  context: FlagOverrideContext,
  expectedType: FlagType,
): ResolutionDetails<T> {
  if (def.type !== expectedType) {
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.TYPE_MISMATCH,
      errorMessage: `flag "${def.key}" is type "${def.type}", not "${expectedType}"`,
    };
  }

  const overrideVariant = context.flagOverrides?.[def.key];
  if (overrideVariant !== undefined && Object.hasOwn(def.variants, overrideVariant)) {
    return {
      value: def.variants[overrideVariant] as T,
      variant: overrideVariant,
      reason: OVERRIDE_REASON,
    };
  }

  let variant = def.defaultVariant;
  let reason: ResolutionReason = StandardResolutionReasons.STATIC;

  if (def.experiment?.enabled) {
    if (!context.targetingKey) warnMissingTargetingKeyOnce(def.key);
    const targetingKey = context.targetingKey ?? ANONYMOUS_TARGETING_KEY;
    variant = assignExperimentVariant(def.key, def.experiment, targetingKey);
    reason = StandardResolutionReasons.SPLIT;
  }

  return { value: def.variants[variant] as T, variant, reason };
}

export class LoreKitFlagProvider implements Provider {
  readonly metadata = { name: 'lorekit-flags' } as const;

  private readonly registry: readonly FlagDefinition[];

  constructor(registry: readonly FlagDefinition[] = FLAG_REGISTRY) {
    this.registry = registry;
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<boolean>> {
    return this.resolveFor(flagKey, defaultValue, context, 'boolean');
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<string>> {
    return this.resolveFor(flagKey, defaultValue, context, 'string');
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<number>> {
    return this.resolveFor(flagKey, defaultValue, context, 'number');
  }

  async resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    _context: EvaluationContext,
    _logger: Logger,
  ): Promise<ResolutionDetails<T>> {
    // No `object`-typed flags in the registry yet (see `FlagTypeSchema`) — refuse
    // rather than silently guessing a shape.
    return {
      value: defaultValue,
      reason: StandardResolutionReasons.ERROR,
      errorCode: ErrorCode.TYPE_MISMATCH,
      errorMessage: `flag "${flagKey}": object-typed flags are not supported by LoreKitFlagProvider`,
    };
  }

  private resolveFor<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
    type: FlagType,
  ): ResolutionDetails<T> {
    const def = this.registry.find((f) => f.key === flagKey);
    if (!def) {
      return {
        value: defaultValue,
        reason: StandardResolutionReasons.ERROR,
        errorCode: ErrorCode.FLAG_NOT_FOUND,
      };
    }
    return resolveFromDefinition(def, defaultValue, context, type);
  }
}
