/**
 * An OpenFeature `Hook` that stamps every flag evaluation onto the active
 * OTel span — the mechanism the A/B testing use case runs on. Register it
 * once (`getFeatureFlagClient` does this) and every `client.getBooleanValue`
 * / `getStringValue` / `getNumberValue` call anywhere in the request gets:
 *
 *   - `feature_flag.key`, `feature_flag.provider.name`,
 *     `feature_flag.result.variant`, `feature_flag.result.reason` as span
 *     attributes (see `otel-attributes.ts` for why these are span, not
 *     Resource, attributes)
 *   - a `feature_flag.evaluation` span event carrying the same data, so a
 *     trace with several flags evaluated in it still shows each one on the
 *     timeline
 *   - a `lorekit.feature_flag.evaluations` counter, dimensioned by key +
 *     variant, for the aggregate query ("treatment converts N% more than
 *     control") that a single trace can't answer on its own
 *
 * No hook fires without a provider resolving the flag first — see
 * `provider.ts`.
 */
import type { EvaluationDetails, FlagValue, Hook, HookContext } from '@openfeature/server-sdk';
import { trace, type Span } from '@opentelemetry/api';
import {
  ATTR_FEATURE_FLAG_CONTEXT_ID,
  ATTR_FEATURE_FLAG_KEY,
  ATTR_FEATURE_FLAG_PROVIDER_NAME,
  ATTR_FEATURE_FLAG_RESULT_REASON,
  ATTR_FEATURE_FLAG_RESULT_VARIANT,
  EVENT_FEATURE_FLAG_EVALUATION,
  METRIC_FEATURE_FLAG_EVALUATIONS,
} from './otel-attributes.ts';
import { getFeatureFlagMeter } from './telemetry.ts';

function baseAttributes(hookContext: Readonly<HookContext>): Record<string, string> {
  const attrs: Record<string, string> = {
    [ATTR_FEATURE_FLAG_KEY]: hookContext.flagKey,
    [ATTR_FEATURE_FLAG_PROVIDER_NAME]: hookContext.providerMetadata.name,
  };
  if (hookContext.context.targetingKey) {
    attrs[ATTR_FEATURE_FLAG_CONTEXT_ID] = hookContext.context.targetingKey;
  }
  return attrs;
}

function stampSpan(span: Span, attrs: Record<string, string>): void {
  for (const [key, value] of Object.entries(attrs)) span.setAttribute(key, value);
  span.addEvent(EVENT_FEATURE_FLAG_EVALUATION, attrs);
}

let _evaluationCounter:
  | ReturnType<ReturnType<typeof getFeatureFlagMeter>['createCounter']>
  | undefined;

function recordEvaluationMetric(flagKey: string, variant: string | undefined): void {
  _evaluationCounter ??= getFeatureFlagMeter().createCounter(METRIC_FEATURE_FLAG_EVALUATIONS, {
    description: 'Feature flag evaluations, dimensioned by flag key and result variant.',
  });
  _evaluationCounter.add(1, {
    [ATTR_FEATURE_FLAG_KEY]: flagKey,
    ...(variant ? { [ATTR_FEATURE_FLAG_RESULT_VARIANT]: variant } : {}),
  });
}

export const featureFlagOtelHook: Hook = {
  after(hookContext: Readonly<HookContext>, details: EvaluationDetails<FlagValue>) {
    const span = trace.getActiveSpan();
    const attrs = baseAttributes(hookContext);
    if (details.variant) attrs[ATTR_FEATURE_FLAG_RESULT_VARIANT] = details.variant;
    // Lowercased: OpenFeature's own `StandardResolutionReasons` values are
    // UPPERCASE ("STATIC", "SPLIT") by its own convention, but the OTel
    // feature-flag semantic conventions' well-known `feature_flag.result.reason`
    // values are lowercase ("static", "split") — see the spec link in
    // `otel-attributes.ts`. Transform at this boundary only; `provider.ts` keeps
    // the idiomatic OpenFeature casing for its own `ResolutionDetails.reason`.
    if (details.reason) attrs[ATTR_FEATURE_FLAG_RESULT_REASON] = details.reason.toLowerCase();
    if (span) stampSpan(span, attrs);
    recordEvaluationMetric(hookContext.flagKey, details.variant);
  },
  error(hookContext: Readonly<HookContext>, error: unknown) {
    const span = trace.getActiveSpan();
    if (!span) return;
    stampSpan(span, baseAttributes(hookContext));
    if (error instanceof Error) span.recordException(error);
  },
};
