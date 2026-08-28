/**
 * Server-side feature-flag evaluation for `packages/web` — Server Components,
 * Server Actions, and Route Handlers.
 *
 * This is the ONLY place in the dashboard that resolves an `EvaluationContext`
 * and calls `@lorekit/feature-flags`' `evaluateFlag`. Client Components never
 * evaluate independently — they read whatever value a Server Component
 * computed here, via `FeatureFlagsProvider` (`client.tsx`). One evaluation
 * site means server and client can never disagree, and a session override
 * (below) automatically reaches both without a second code path to keep in
 * sync — see `docs/feature-flags.md` § "packages/web integration".
 */
import { cache } from 'react';
import type { EvaluationContext } from '@openfeature/server-sdk';
import {
  FLAG_KEYS,
  evaluateFlag,
  evaluateFlagDetails,
  parseFlagOverrides,
  withFlagOverrides,
  type FlagKey,
  type FlagValueMap,
} from '@lorekit/feature-flags';
import { cookies } from 'next/headers';
import { createServerClient } from '@/lib/supabase/server';
import { readFlagAnonId } from './anon-id';
import { FLAG_OVERRIDES_COOKIE } from './overrides-cookie';

/**
 * Build this request's `EvaluationContext`: `targetingKey` from the
 * authenticated user, falling back to the flag-anon-id cookie for a visitor
 * with no session yet, plus any session override.
 *
 * `knownUserId` lets a caller that has ALREADY resolved the session (the
 * dashboard layout calls `supabase.auth.getUser()` once for its own auth
 * check — see `resolveDashboardBootstrap`) pass the id straight through
 * instead of this function issuing a SECOND `auth.getUser()` round trip for
 * the exact same session. Omit it from a standalone call site (a Server
 * Action invoked outside the layout tree, a Route Handler) and it resolves
 * the session itself.
 *
 * `cache()`d regardless, so a page calling `getServerFlag` several times (or
 * `getAllServerFlags` once) with the SAME `knownUserId` argument shares one
 * result per request — React's `cache()` keys on argument identity, so this
 * only dedupes calls that agree on `knownUserId`, which every real call site
 * does (the layout always passes its own resolved id).
 */
export const resolveFeatureFlagContext = cache(
  async (knownUserId?: string | null): Promise<EvaluationContext> => {
    const [userId, anonId, overridesCookie] = await Promise.all([
      knownUserId !== undefined ? knownUserId : resolveUserId(),
      readFlagAnonId(),
      cookies().then((store) => store.get(FLAG_OVERRIDES_COOKIE)?.value),
    ]);

    const targetingKey = userId ?? anonId;
    const overrides = parseFlagOverrides(overridesCookie);

    return withFlagOverrides(targetingKey ? { targetingKey } : {}, overrides);
  },
);

async function resolveUserId(): Promise<string | null> {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}

/** Evaluate one flag server-side. Safe to call from a Server Component or Server Action. */
export async function getServerFlag<K extends FlagKey>(
  key: K,
  knownUserId?: string | null,
): Promise<FlagValueMap[K]> {
  const context = await resolveFeatureFlagContext(knownUserId);
  return evaluateFlag(key, context);
}

/**
 * Evaluate every declared flag server-side in one pass — what
 * `FeatureFlagsProvider` is seeded with (see `app/(dashboard)/layout.tsx`).
 * Small today (3 flags); if the registry grows large enough that evaluating
 * all of them on every dashboard request is wasteful, narrow this to an
 * explicit `keys: FlagKey[]` parameter — the call site already controls what
 * it asks for, so that change is additive, not a redesign.
 */
export async function getAllServerFlags(knownUserId?: string | null): Promise<FlagValueMap> {
  const context = await resolveFeatureFlagContext(knownUserId);
  const entries = await Promise.all(
    FLAG_KEYS.map(async (key) => [key, await evaluateFlag(key, context)] as const),
  );
  return Object.fromEntries(entries) as unknown as FlagValueMap;
}

/**
 * Every declared flag's resolved VALUE and VARIANT, in one pass —
 * `{ values, variants }`. `values` is what `getAllServerFlags` already
 * returns (`FeatureFlagsProvider`'s `flags` prop, what `useFeatureFlag` reads).
 * `variants` — flag key -> variant KEY string (`"treatment"`, not `true`) — is
 * what `FeatureFlagsProvider` forwards into
 * `syncFeatureFlagRumAttributes` (`lib/dash0-rum.ts`) so a Web Events /
 * RUM search can filter or group by `feature_flag.<key>`. See
 * `docs/feature-flags.md` § "Feature flags in telemetry" for why this is a
 * SEPARATE representation from the OTel semconv attributes the server-side
 * hook stamps on spans.
 *
 * Uses `evaluateFlagDetails` (one call per flag, not two) so this never
 * double-evaluates — and never double-fires the OTel hook — relative to a
 * plain `getAllServerFlags()` call for the same request.
 */
export async function getAllServerFlagState(
  knownUserId?: string | null,
): Promise<{ values: FlagValueMap; variants: Record<FlagKey, string> }> {
  const context = await resolveFeatureFlagContext(knownUserId);
  const entries = await Promise.all(
    FLAG_KEYS.map(async (key) => {
      const details = await evaluateFlagDetails(key, context);
      return [key, details] as const;
    }),
  );

  const values: Record<string, unknown> = {};
  const variants: Record<string, string> = {};
  for (const [key, details] of entries) {
    values[key] = details.value;
    // `variant` is optional per the OpenFeature spec, but `LoreKitFlagProvider`
    // always sets it (static/experiment/override all do) — the fallback only
    // guards a hypothetical future provider that doesn't.
    variants[key] = details.variant ?? String(details.value);
  }
  return {
    values: values as unknown as FlagValueMap,
    variants: variants as Record<FlagKey, string>,
  };
}
