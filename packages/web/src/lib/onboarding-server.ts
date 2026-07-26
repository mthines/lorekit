import { cache } from 'react';
import type { OnboardingServerState } from './onboarding';

/**
 * Server-side onboarding completion signals, derived from the user's memories.
 *
 * Kept separate from `onboarding.ts` (which stays client-safe) because this
 * reaches for the Supabase server client, so importing it into a client bundle
 * already fails the build. Shared by the dashboard layout — so the sidebar entry
 * can show live progress — and by the pages that build the checklist. RLS scopes
 * both counts to the authenticated user.
 *
 * Wrapped in React `cache()` so the two count queries run at most once per
 * request even if several server components ask for the state in one render.
 */
export const getOnboardingState = cache(async (): Promise<OnboardingServerState> => {
  const { createServerClient } = await import('@/lib/supabase/server');
  const supabase = await createServerClient();

  const [lessonsRes, webhookRes] = await Promise.all([
    supabase.from('memories').select('id', { count: 'exact', head: true }),
    supabase
      .from('memories')
      .select('id', { count: 'exact', head: true })
      .contains('tags', ['source::pr-webhook']),
  ]);

  return {
    hasLessons: (lessonsRes.count ?? 0) > 0,
    hasWebhook: (webhookRes.count ?? 0) > 0,
  };
});
