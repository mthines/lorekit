'use server';

/**
 * Server Actions backing the Developer settings page's flag overrides
 * (`app/(dashboard)/settings/developer/`).
 *
 * Each action reads the current override cookie, applies one change through
 * `@lorekit/feature-flags`' `parseFlagOverrides`/`serializeFlagOverrides`
 * (never hand-rolled JSON — the same validation-on-read guarantee the
 * cookie gets everywhere else applies here too), writes it back, and calls
 * `revalidatePath('/', 'layout')` so every Server Component under the
 * dashboard layout — which is where `FeatureFlagsProvider` is seeded, see
 * `app/(dashboard)/layout.tsx` — re-evaluates on the next render. That single
 * invalidation is what makes an override apply to BOTH the server (a fresh
 * RSC render reads the new cookie) and the client (the fresh render re-seeds
 * `FeatureFlagsProvider` with the new values) without a second mechanism for
 * either.
 */
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  FLAG_REGISTRY,
  parseFlagOverrides,
  serializeFlagOverrides,
  type FlagOverrides,
} from '@lorekit/feature-flags';
import { FLAG_OVERRIDES_COOKIE, FLAG_OVERRIDES_MAX_AGE_SECONDS } from './overrides-cookie';

async function readOverrides(): Promise<FlagOverrides> {
  const store = await cookies();
  return parseFlagOverrides(store.get(FLAG_OVERRIDES_COOKIE)?.value);
}

async function writeOverrides(overrides: FlagOverrides): Promise<void> {
  const store = await cookies();
  if (Object.keys(overrides).length === 0) {
    store.delete(FLAG_OVERRIDES_COOKIE);
  } else {
    store.set(FLAG_OVERRIDES_COOKIE, serializeFlagOverrides(overrides), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: FLAG_OVERRIDES_MAX_AGE_SECONDS,
      path: '/',
    });
  }
  revalidatePath('/', 'layout');
}

/** Set (or replace) the override for one flag. Rejects a flag/variant pair not in the registry. */
export async function setFlagOverrideAction(flagKey: string, variant: string): Promise<void> {
  const def = FLAG_REGISTRY.find((f) => f.key === flagKey);
  if (!def || !Object.hasOwn(def.variants, variant)) return;

  const overrides = await readOverrides();
  await writeOverrides({ ...overrides, [flagKey]: variant });
}

/** Clear the override for one flag, reverting it to normal (static/experiment) resolution. */
export async function clearFlagOverrideAction(flagKey: string): Promise<void> {
  const overrides = await readOverrides();
  if (!Object.hasOwn(overrides, flagKey)) return;
  const rest = Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== flagKey));
  await writeOverrides(rest);
}

/** Clear every override — the Developer page's "Reset all" action. */
export async function clearAllFlagOverridesAction(): Promise<void> {
  await writeOverrides({});
}
