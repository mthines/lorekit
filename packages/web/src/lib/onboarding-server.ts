import type { OnboardingServerState } from './onboarding';

/**
 * Server-side onboarding completion signals, derived from the user's memories.
 *
 * Kept separate from `onboarding.ts` (which stays client-safe) because this
 * reaches for the Supabase server client. Shared by the dashboard layout — so
 * the sidebar entry can show live progress — and by the pages that build the
 * checklist. RLS scopes both counts to the authenticated user.
 */
export async function getOnboardingState(): Promise<OnboardingServerState> {
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
}
