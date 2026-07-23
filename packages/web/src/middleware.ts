import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** 24 hours — matches the Supabase project jwt_expiry so the cookie
 *  outlives the access token and the refresh token can be used. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24;

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

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
          response = NextResponse.next({ request });
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
  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};