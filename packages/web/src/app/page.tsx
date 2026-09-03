import { redirect } from 'next/navigation';
import { getVerifiedUser } from '@/lib/auth/verified-user';
import { classifyAuthCallback } from '@/lib/auth-callback-params';
import { getServerFlag } from '@/lib/feature-flags/server';

type SearchParams = Record<string, string | string[] | undefined>;

function toURLSearchParams(input: SearchParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') params.append(key, value);
    else if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
  }
  return params;
}

export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = toURLSearchParams(await searchParams);

  // Supabase falls back to the project's **Site URL** when an email link's
  // `redirect_to` is not on the allow-list — which lands the user here,
  // mid-authentication, instead of on /api/auth/callback. Forward the auth
  // params on rather than dropping them at /login.
  //
  // Only the query-string shapes can be rescued server-side; an implicit-flow
  // `#access_token=…` fragment never reaches the server and is picked up by
  // AuthHashCatcher after this redirect lands on /login.
  if (classifyAuthCallback(params).kind !== 'none') {
    if (!params.has('next')) params.set('next', '/welcome');
    redirect(`/api/auth/callback?${params.toString()}`);
  }

  const user = await getVerifiedUser();
  if (user) {
    // While `insights-page` is on, Insights takes Overview's "home" slot —
    // including its onboarding duties, which is why the landing route is
    // `/insights` and not `/lore`: `buildOnboardingSteps({ autoGenerateToken:
    // true })` mints a brand-new user's first API token, and landing anywhere
    // that does not call it leaves a fresh signup with no token and no setup
    // instructions. Overview stays reachable by direct URL, just unreferenced.
    // See Sidebar.tsx's matching nav filter and insights/page.tsx's gate.
    const insightsEnabled = await getServerFlag('insights-page', user.id);
    redirect(insightsEnabled ? '/insights' : '/overview');
  }
  redirect('/login');
}
