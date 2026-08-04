'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { friendlyAuthError } from '@/lib/auth-errors';
import { reportAuthFailure, reportAuthSuccess } from '@/lib/auth-telemetry';
import { DEFAULT_POST_LOGIN_PATH } from '@/lib/auth-redirect';
import { fragmentCarriesAuthResult } from '@/lib/auth-callback-params';

/**
 * How long to wait for supabase-js to resolve an implicit-flow fragment
 * (`#access_token=…`) before concluding there is no session. Detection is
 * synchronous-ish but happens off the constructor, so a small grace period
 * avoids flashing "please sign in" at a user who is about to be signed in.
 */
const HASH_DETECTION_GRACE_MS = 1500;

type State = 'checking' | 'signed-in' | 'signed-out';

/**
 * The page a newly-confirmed account lands on.
 *
 * Confirmation can arrive in three shapes and only one of them reliably
 * produces a session on the server (see `lib/auth-callback-params.ts`), so
 * this page reports whichever actually happened instead of assuming:
 *
 * - Session established (PKCE or token-hash verified by the callback route,
 *   or an implicit fragment resolved here) → "you're all set", continue.
 * - Confirmed but not signed in (link opened in another browser, or the
 *   project bounced to the Site URL) → say the account is ready and send them
 *   to sign in. This is a normal outcome, not an error.
 * - Supabase reported an error → show why, and offer sign-in.
 */
export function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorCode = searchParams.get('error');

  const [state, setState] = useState<State>('checking');
  const settled = useRef(false);

  useEffect(() => {
    // A provider error is terminal: the render below returns the error branch
    // whatever the session state turns out to be, so resolving one is dead
    // work. It is also the only place `email_confirmation` can report a
    // failure — without this the method emits successes only and its failure
    // rate is invisible in the funnel. The `settled` guard is shared with the
    // success emit, so the two are mutually exclusive and a StrictMode
    // double-invoke cannot double-count. The code is the provider's, the same
    // value `api/auth/callback/route.ts` already records as `auth.error_code`.
    if (errorCode) {
      if (!settled.current) {
        settled.current = true;
        reportAuthFailure('email_confirmation', { code: errorCode });
      }
      return;
    }

    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;

    function settle(next: State) {
      if (settled.current) return;
      settled.current = true;
      setState(next);
      if (next === 'signed-in') {
        reportAuthSuccess('email_confirmation');
        // Drop the implicit-flow fragment so a refresh (or a shared URL) does
        // not carry credentials around.
        if (typeof window !== 'undefined' && window.location.hash) {
          window.history.replaceState({}, '', window.location.pathname + window.location.search);
        }
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) settle('signed-in');
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        settle('signed-in');
        return;
      }
      // No session yet. If the URL carries an implicit-flow fragment,
      // supabase-js is still working on it — wait briefly before giving up.
      const grace =
        typeof window !== 'undefined' && fragmentCarriesAuthResult(window.location.hash)
          ? HASH_DETECTION_GRACE_MS
          : 0;
      timer = setTimeout(() => settle('signed-out'), grace);
    });

    return () => {
      subscription.unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [errorCode]);

  function handleContinue() {
    router.push(DEFAULT_POST_LOGIN_PATH);
    router.refresh();
  }

  if (errorCode) {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="text-sm text-red-400">
          {friendlyAuthError({ message: errorCode, code: errorCode })}
        </p>
        <Link
          href="/login"
          className="flex h-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)]"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  if (state === 'checking') {
    return (
      <p role="status" className="text-sm text-[var(--color-content-secondary)]">
        Finishing up...
      </p>
    );
  }

  if (state === 'signed-in') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <CheckCircle2 className="size-5 shrink-0 text-[var(--color-success)]" aria-hidden />
          <p className="text-sm text-[var(--color-content-primary)]">
            Your email is confirmed and you&apos;re signed in.
          </p>
        </div>
        <button
          onClick={handleContinue}
          className="flex h-11 items-center justify-center rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-subtle)] px-4 text-sm font-semibold text-[var(--color-accent)] transition-all duration-200 hover:shadow-[0_0_20px_var(--color-accent-glow)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          Continue to your dashboard
        </button>
      </div>
    );
  }

  // Confirmed, but the session did not land in this browser.
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5">
        <CheckCircle2 className="size-5 shrink-0 text-[var(--color-success)]" aria-hidden />
        <p className="text-sm text-[var(--color-content-primary)]">
          Your email is confirmed — your account is ready.
        </p>
      </div>
      <p className="text-xs text-[var(--color-content-secondary)]">
        Sign in with your email and password to continue. (If you opened this link on a different
        device from the one you signed up on, that&apos;s expected — you only need to confirm once.)
      </p>
      <Link
        href="/login"
        className="flex h-11 items-center justify-center rounded-xl border border-[var(--color-accent)] bg-[var(--color-accent-subtle)] px-4 text-sm font-semibold text-[var(--color-accent)] transition-all duration-200 hover:shadow-[0_0_20px_var(--color-accent-glow)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        Continue to sign in
      </Link>
    </div>
  );
}
