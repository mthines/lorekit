/**
 * OpenTelemetry feature-flag attribute names, per the (experimental) OTel
 * semantic conventions for feature flags:
 * https://opentelemetry.io/docs/specs/semconv/registry/attributes/feature-flag/
 *
 * Not sourced from `@opentelemetry/semantic-conventions` — the feature-flag
 * group is still in the "incubating" tier, and the version pinned across this
 * repo (`^1.9.0` for `@opentelemetry/api`, matching `packages/mcp-core` and
 * `packages/web`) does not ship an incubating export for it. Declared here as
 * plain string constants instead of a version-fragile extra dependency; if
 * `@opentelemetry/semantic-conventions` ships a stable export for these later,
 * swap the right-hand sides for the imported constants — the keys don't move.
 *
 * ## Why these are SPAN attributes, not Resource attributes
 *
 * A `Resource` is fixed for the lifetime of one SDK instance (it describes
 * *the process* — service name, version, host). An A/B variant is decided
 * *per evaluation* — per request, per user — inside a long-lived server
 * process serving every arm of the experiment at once, so it cannot be a
 * process-wide Resource attribute without one process per variant. The
 * correct place to carry a per-request fact is the span (and, for the same
 * reason, any log or metric emitted in that request's context) — which is
 * exactly what `featureFlagOtelHook` below does, and precisely what
 * "does variant X convert better than variant Y" needs: filter every span
 * (and its descendants — conversion events, checkout spans, error spans) by
 * `feature_flag.result.variant` and compare outcome rates between arms.
 */

export const ATTR_FEATURE_FLAG_KEY = 'feature_flag.key';
export const ATTR_FEATURE_FLAG_PROVIDER_NAME = 'feature_flag.provider.name';
export const ATTR_FEATURE_FLAG_CONTEXT_ID = 'feature_flag.context.id';
export const ATTR_FEATURE_FLAG_RESULT_VARIANT = 'feature_flag.result.variant';
export const ATTR_FEATURE_FLAG_RESULT_REASON = 'feature_flag.result.reason';

/** Span event name emitted on every evaluation, alongside the attributes above. */
export const EVENT_FEATURE_FLAG_EVALUATION = 'feature_flag.evaluation';

/** `lorekit.feature_flag.evaluations` — counter dimensioned by key + variant. */
export const METRIC_FEATURE_FLAG_EVALUATIONS = 'lorekit.feature_flag.evaluations';
