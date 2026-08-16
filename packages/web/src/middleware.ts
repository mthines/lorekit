import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
// Dependency-free pure module — safe to pull into the edge middleware bundle.
// Shared with /api/auth/callback and the client-side password sign-in so all
// three enforce one definition of a safe `?next=` target.
import { safeNextPath, boundedReturnTo } from '@/lib/auth-redirect';
// The one list of paths that require a session, kept in step with
// app/(dashboard) by a filesystem drift guard in its spec.
import { isProtectedPath } from '@/lib/protected-routes';

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

  // No URL is forwarded to the RSC tree any more.
  //
  // This used to copy `x-pathname` + `x-search` into a REQUEST HEADER on every
  // matched request, because the auth gate lived in `app/(dashboard)/layout.tsx`
  // and a layout cannot see the query string — the App Router does not pass
  // `searchParams` to a layout and a layout cannot reach the raw `Request`.
  // Preserving a shared link through login therefore meant smuggling the URL
  // downstream as a header, which the layout read back and percent-encoded a
  // SECOND time into `?next=`.
  //
  // That copy turned URL length into header length on every request, and a wide
  // Lore Explorer filter bar (`?filters=` is kilobytes of encoded JSON by
  // design) took the round trip past the header limit — a `431` with nothing
  // the user could act on. It existed only to feed a SECOND gate re-deciding
  // what this middleware, which already calls `getUser()` to refresh the
  // session cookie, had just decided. The gate moved here (below); the header
  // is gone.
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: Array<{ name: string; value: string; options?: CookieOptions }>) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request: { headers: request.headers } });
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

  // The auth gate. The inverse of the redirect above, and it belongs here for
  // the same reason that one does: the session is already resolved, and
  // `request.nextUrl` carries the pathname AND the search string, so the
  // return target is built once, in one place, with no header round trip.
  //
  // `app/(dashboard)/layout.tsx` keeps a bare `redirect('/login')` as
  // defence in depth. It should be unreachable — if it ever fires, this gate
  // and `PROTECTED_SEGMENTS` have fallen out of step with the route tree, and
  // the user loses the link rather than the page.
  //
  // GET only, deliberately. A Next.js Server Action is a POST to the page's own
  // URL, and answering a fetch that expects an action result with a 302 to an
  // HTML login page is a worse failure than the one the actions already handle:
  // every server action here resolves its own token and fails closed (an empty
  // page for a read), so an expired session degrades the data and the next
  // navigation — a GET — lands on the login screen with its link intact.
  if (!user && request.method === 'GET' && isProtectedPath(request.nextUrl.pathname)) {
    // Bounded: `?next=` percent-encodes the whole target, and a wide filter bar
    // is kilobytes before encoding. Past the budget the user comes back to the
    // bare page instead of to a request nobody can serve. The address bar itself
    // is never truncated — a pasted link has to keep working.
    const next = boundedReturnTo(request.nextUrl.pathname, request.nextUrl.search);
    const login = new URL('/login', request.url);
    login.searchParams.set('next', next);
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
