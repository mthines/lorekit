/**
 * Session-override support — how a developer/admin forces a specific variant
 * for their own session without touching the registry.
 *
 * This module is deliberately **framework-agnostic and transport-agnostic**:
 * it knows nothing about cookies, `next/headers`, or HTTP. It only defines the
 * override MAP shape (`FlagOverrides` — flag key -> variant key) and how to
 * fold one into an `EvaluationContext` (`withFlagOverrides`), plus how to
 * parse one back out of an untrusted string (`parseFlagOverrides`) — the
 * shape a cookie, a query param, or a header value all reduce to.
 *
 * `LoreKitFlagProvider.resolveFor` (`provider.ts`) checks `flagOverrides` on
 * the context FIRST, before static/experiment resolution — an override always
 * wins, and is reported with `reason: 'OVERRIDE'` (a custom OpenFeature
 * reason; the OTel semconv spec explicitly allows a custom
 * `feature_flag.result.reason` value when none of the well-known ones apply).
 *
 * ## Why overrides live in `EvaluationContext`, not a provider constructor arg
 *
 * An override is a property of ONE evaluation (this request, this session),
 * not of the provider (which is process-wide, registered once — see
 * `client.ts`). Threading it through `EvaluationContext`, the same channel
 * `targetingKey` already travels through, means the override is naturally
 * per-call and never leaks between requests/sessions in a shared process —
 * the same reasoning that keeps `targetingKey` out of the provider too.
 *
 * ## Where the actual cookie/HTTP plumbing lives
 *
 * Deliberately NOT here. Reading a cookie needs `next/headers` (Next.js
 * Server Components) or `document.cookie` (browser) or a raw `Cookie` header
 * (Deno edge functions) — three different APIs for three different hosts this
 * package already runs on (`packages/web`, browsers, `supabase/functions/`).
 * Each host owns its own thin adapter that calls `parseFlagOverrides` /
 * `serializeFlagOverrides` and nothing else; see
 * `packages/web/src/lib/feature-flags/` for the Next.js one.
 */
import type { EvaluationContext } from '@openfeature/server-sdk';
import { FLAG_REGISTRY } from './registry.ts';

/** Flag key -> the variant key to force for this evaluation. */
export type FlagOverrides = Record<string, string>;

/**
 * The `EvaluationContext` field `LoreKitFlagProvider` reads overrides from.
 * Exported as a named constant (rather than inlined at both call sites) so a
 * rename is a one-line change instead of a grep-and-hope.
 */
export const FLAG_OVERRIDES_CONTEXT_KEY = 'flagOverrides' as const;

/** The OpenFeature resolution reason `LoreKitFlagProvider` reports for an override hit. */
export const OVERRIDE_REASON = 'OVERRIDE';

/**
 * An `EvaluationContext` carrying an optional override map. `LoreKitFlagProvider`
 * accepts a plain `EvaluationContext` (it must — that's the OpenFeature
 * `Provider` interface) and narrows to this shape internally.
 *
 * A type-alias INTERSECTION, not `interface ... extends EvaluationContext` —
 * `EvaluationContext` is itself `{ targetingKey?: string } & Record<string,
 * EvaluationContextValue>`, and `interface extends` on a type carrying a
 * `Record<string, V>` re-checks every member (inherited ones included)
 * against that index signature, which an optional property always fails
 * (its type includes `undefined`, which `V` never does). An intersection
 * doesn't apply that check.
 */
export type FlagOverrideContext = EvaluationContext & {
  [FLAG_OVERRIDES_CONTEXT_KEY]?: FlagOverrides;
};

/** Fold an override map into an evaluation context. Returns a NEW object — never mutates `context`. */
export function withFlagOverrides(
  context: EvaluationContext,
  overrides: FlagOverrides,
): FlagOverrideContext {
  return { ...context, [FLAG_OVERRIDES_CONTEXT_KEY]: overrides };
}

/**
 * Parse a raw override string (a cookie value, typically) into a validated
 * `FlagOverrides` map.
 *
 * **Never trusts the input.** A cookie is user-controlled storage — malformed
 * JSON, an unknown flag key, or a variant that doesn't exist for that flag are
 * all realistic (a stale cookie from a flag that was since removed, a variant
 * that was renamed, manual tampering) and every one of them is silently
 * DROPPED rather than thrown — one bad entry must never break evaluation for
 * every other flag, and a parse failure must never crash the request. Pass
 * `registry` to validate against a specific flag set (tests); defaults to the
 * real `FLAG_REGISTRY`.
 */
export function parseFlagOverrides(
  raw: string | undefined | null,
  registry: typeof FLAG_REGISTRY = FLAG_REGISTRY,
): FlagOverrides {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const valid: FlagOverrides = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const def = registry.find((f) => f.key === key);
    if (!def) continue;
    if (!Object.hasOwn(def.variants, value)) continue;
    valid[key] = value;
  }
  return valid;
}

/** Serialize an override map for storage (a cookie value). Inverse of `parseFlagOverrides`. */
export function serializeFlagOverrides(overrides: FlagOverrides): string {
  return JSON.stringify(overrides);
}
