import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
// Dependency-free pure module — safe to pull into the edge middleware bundle.
// Shared with /api/auth/callback and the client-side password sign-in so all
// three enforce one definition of a safe `?next=` target.
import { safeNextPath, boundedReturnTo } from '@/lib/auth-redirect';
import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase/config';

/** 24 hours — matches the Supabase project jwt_expiry so the cookie
 *  outlives the access token and the refresh token can be used. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;

export async function middleware(request: NextRequest) {
  // Short-circuit OPTIONS preflights before hitting any auth logic.
  //
  // Next.js Server Actions are invoked as POST requests to the page route that
  // hosts them (e.g. `POST /` for actions in lib/lore.ts, called from /lore).
  // Browsers send a CORS preflight (OPTIONS) before that POST when the request
  // includes non-simple headers such as `Next-Action`. Without this handler,
  // Next.js returns 400 because page routes have no OPTIONS handler — and the
  // Supabase `getUser()` call below would run unnecessarily on every preflight.
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': [
          'Content-Type',
          'Authorization',
          'Next-Action',
          'Next-Router-State-Tree',
          'Next-Router-Prefetch',
          'traceparent',
          'tracestate',
        ].join(', '),
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Forward the pathname + search string as a request header so RSC layouts
  // can read the full URL without accessing the raw Request object.
  // Used by the dashboard layout to preserve shared URLs (e.g. ?lesson=…)
  // through the unauthenticated → login → callback → original URL flow.
  //
  // BOUNDED, because this turns URL length into HEADER length on every matched
  // request. The Explorer's filter bar lives in ?filters= by design, and a wide
  // bar is kilobytes of percent-encoded JSON; copied here and then re-encoded
  // into ?next= by the layout, it is what takes the round trip past the header
  // limit and returns a 431 the user cannot act on. Past the budget the header
  // carries the pathname alone — the return trip loses the bar, never the page.
  // The address bar itself is untouched: a pasted link must keep working, and
  // the client that reads it has no header limit.
  const forwardedTarget = boundedReturnTo(request.nextUrl.pathname, request.nextUrl.search);
  const forwardedSearch = forwardedTarget.slice(request.nextUrl.pathname.length);
  let response = NextResponse.next({
    request: {
      headers: new Headers({
        ...Object.fromEntries(request.headers),
        'x-pathname': request.nextUrl.pathname,
        'x-search': forwardedSearch,
      }),
    },
  });

  const supabase = createServerClient(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({
            request: {
              headers: new Headers({
                ...Object.fromEntries(request.headers),
                'x-pathname': request.nextUrl.pathname,
                'x-search': forwardedSearch,
              }),
            },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, {
              ...options,
              // Persist the session cookie across browser restarts so the
              // refresh token survives and the user stays logged in for the day.
              maxAge: SESSION_MAX_AGE_SECONDS,
            }),
          );
        },
      },
    },
  );

  // Refresh session if the access token has expired; supabase-ssr will
  // transparently use the refresh token and write new cookies via setAll.
  const { data: { user } } = await supabase.auth.getUser();

  // Redirect authenticated users away from /login. Honour the ?next= param so
  // a logged-in user landing on /login?next=/lore/xyz is sent to their intended
  // destination rather than unconditionally to /overview.
  // safeNextPath rejects scheme-relative URLs (//evil.com) and absolute URLs
  // that would otherwise bypass the same-origin constraint.
  if (user && request.nextUrl.pathname === '/login') {
    const next = safeNextPath(request.nextUrl.searchParams.get('next'));
    return NextResponse.redirect(new URL(next, request.url));
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
