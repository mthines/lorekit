import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';
import { classifyAuthCallback } from '@/lib/auth-callback-params';

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

  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect('/dashboard');
  redirect('/login');
}
