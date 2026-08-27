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
import { FLAG_REGISTRY } from './registry.ts';
import type { FlagDefinition, FlagType } from './schema.ts';

const ANONYMOUS_TARGETING_KEY = 'anonymous';

function resolveFromDefinition<T extends JsonValue>(
  def: FlagDefinition,
  defaultValue: T,
  context: EvaluationContext,
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

  let variant = def.defaultVariant;
  let reason: ResolutionReason = StandardResolutionReasons.STATIC;

  if (def.experiment?.enabled) {
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
