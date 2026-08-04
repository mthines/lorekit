'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { friendlyAuthError } from '@/lib/auth-errors';
import { reportAuthAttempt, reportAuthFailure, reportAuthSuccess } from '@/lib/auth-telemetry';
import { validatePassword } from '@/lib/password-policy';
import { authCallbackOrigin, buildAuthCallbackUrl } from '@/lib/auth-callback-url';
import { safeNextPath } from '@/lib/auth-redirect';
import { FIELD_CLASS } from './field-styles';

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

interface LoginButtonProps {
  /**
   * When true, renders a smaller nav-style button (no minimum width, less padding).
   * Use in the top-nav on the login page.
   */
  compact?: boolean;
}

/**
 * Which panel of the sign-in flow is showing.
 *
 * - `idle`      — provider choice (GitHub / email + password / magic link)
 * - `password`  — email + password form (sign in or create account)
 * - `magic`     — email-only form that sends a magic link
 * - `sent`      — magic link sent confirmation
 * - `confirm`   — password sign-up done, confirmation email sent
 */
type Step = 'idle' | 'password' | 'magic' | 'sent' | 'confirm';

/** Whether the password form signs into an existing account or creates one. */
type PasswordMode = 'signin' | 'signup';

const PRIMARY_BUTTON_CLASS =
  'flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50';

const LINK_CLASS =
  'text-xs text-[var(--color-content-tertiary)] underline-offset-2 hover:text-[var(--color-content-secondary)] hover:underline';

export function LoginButton({ compact = false }: LoginButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [passwordMode, setPasswordMode] = useState<PasswordMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Read the ?next= param set by the dashboard layout when redirecting unauthenticated
  // users to /login. After the OAuth/magic-link callback, /api/auth/callback will
  // redirect there instead of /dashboard, preserving shared URLs (e.g. ?lesson=...).
  // The password path never leaves the SPA, so it navigates there itself.
  const searchParams = useSearchParams();
  const nextParam = searchParams.get('next');

  function callbackUrl(): string {
    return buildAuthCallbackUrl(authCallbackOrigin(), nextParam);
  }

  function resetTo(next: Step) {
    setStep(next);
    setError('');
    setPassword('');
  }

  async function handleGitHubLogin() {
    setLoading(true);
    // Recorded BEFORE the redirect: this document is about to be replaced,
    // so this is the only moment the intent can be captured at all.
    reportAuthAttempt('github_oauth');
    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: callbackUrl(),
      },
    });
    // On success the page is already being replaced, so loading stays true.
    // On failure it never redirects: without this branch the attempt above
    // would have no terminal event — and OAuth emits no success by design, so
    // a failed initiation would be indistinguishable from a completed one and
    // would count as drop-off. The button would also stay disabled forever.
    if (oauthError) {
      reportAuthFailure('github_oauth', oauthError);
      setError(friendlyAuthError(oauthError));
      setLoading(false);
    }
  }

  async function handleMagicLinkSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }

    setBusy(true);
    reportAuthAttempt('email_otp');
    const supabase = createClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      // Pass the email exactly as the user typed it. Plus-subaddressed variants
      // (user+alias@example.com) are valid and distinct Supabase identities —
      // Supabase creates an account on first use (shouldCreateUser: true) and
      // delivers the magic link to the typed address. We do NOT strip the alias
      // here because that would silently change which account the user logs into.
      email: email.trim(),
      options: {
        emailRedirectTo: callbackUrl(),
        shouldCreateUser: true,
      },
    });
    setBusy(false);
    if (otpError) {
      reportAuthFailure('email_otp', otpError);
      setError(friendlyAuthError(otpError));
    } else {
      reportAuthSuccess('email_otp');
      setStep('sent');
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }
    if (!password) {
      setError('Please enter your password.');
      return;
    }
    // Only pre-validate the policy when a password is being *set*. On sign-in
    // an existing (possibly older, shorter) password must still be accepted —
    // rejecting it client-side would lock the user out of their own account.
    if (passwordMode === 'signup') {
      const policyError = validatePassword(password);
      if (policyError) {
        setError(policyError);
        return;
      }
    }

    setBusy(true);
    const method = passwordMode === 'signup' ? 'email_password_signup' : 'email_password';
    reportAuthAttempt(method);
    const supabase = createClient();

    if (passwordMode === 'signin') {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (signInError) {
        setBusy(false);
        reportAuthFailure(method, signInError);
        setError(friendlyAuthError(signInError));
        return;
      }
      // The browser client has written the session cookies; refresh so the
      // server components on the destination see the authenticated user.
      reportAuthSuccess(method);
      router.push(safeNextPath(nextParam));
      router.refresh();
      return;
    }

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      // Confirmation returns to /welcome rather than straight to the dashboard:
      // whether the click actually produces a session depends on the link shape
      // and on which browser it was opened in, so the user gets a page that
      // states the outcome instead of a silent bounce to the login screen.
      options: { emailRedirectTo: buildAuthCallbackUrl(authCallbackOrigin(), '/welcome') },
    });
    setBusy(false);
    if (signUpError) {
      reportAuthFailure(method, signUpError);
      setError(friendlyAuthError(signUpError));
      return;
    }
    if (data.session) {
      // Email confirmation is disabled on this project — the account is live.
      reportAuthSuccess(method);
      router.push(safeNextPath(nextParam));
      router.refresh();
      return;
    }
    // Confirmation required. Supabase deliberately returns a user with no
    // identities (and no session) when the address is already registered, so
    // this same screen is shown either way — it must not reveal which.
    //
    // Deliberately NOT reported as a success: no session exists yet, and the
    // branch is also what an already-registered address takes. Counting it
    // would both overstate signups and leak the distinction the screen exists
    // to hide. `email_confirmation` on /welcome is where that path completes.
    setStep('confirm');
  }

  // -- Compact variant (top-right nav button on login page) --
  if (compact) {
    return (
      // This variant shares handleGitHubLogin with the full one, so it can fail
      // the same way — and it sits in a header row, so the message goes BESIDE
      // the button rather than below it: a block-level region would restructure
      // that row. Without it the button just reverts to "Sign in" and the user
      // has no signal that anything went wrong, let alone what.
      <div className="flex items-center gap-2">
        {error && (
          <p role="alert" className="max-w-[16rem] text-right text-xs text-red-400">
            {error}
          </p>
        )}
        <button
          onClick={handleGitHubLogin}
          disabled={loading}
          className="flex h-9 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3.5 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          aria-busy={loading}
        >
          <GitHubIcon className="size-3.5 shrink-0" />
          {loading ? 'Redirecting...' : 'Sign in'}
        </button>
      </div>
    );
  }

  // -- Full variant (hero CTA) --

  // Magic-link sent confirmation
  if (step === 'sent') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <MailIcon className="size-5 text-[var(--color-accent)]" />
        </div>
        <p className="text-sm font-medium text-[var(--color-content-primary)]">Check your inbox</p>
        <p className="max-w-xs text-xs text-[var(--color-content-secondary)]">
          We sent a magic link to{' '}
          <span className="font-medium text-[var(--color-content-primary)]">{email}</span>. Click it
          to sign in — no password needed.
        </p>
        <button
          onClick={() => {
            setEmail('');
            resetTo('idle');
          }}
          className={LINK_CLASS}
        >
          Use a different address
        </button>
      </div>
    );
  }

  // Sign-up confirmation email sent
  if (step === 'confirm') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <MailIcon className="size-5 text-[var(--color-accent)]" />
        </div>
        <p className="text-sm font-medium text-[var(--color-content-primary)]">
          Confirm your email
        </p>
        <p className="max-w-xs text-xs text-[var(--color-content-secondary)]">
          We sent a confirmation link to{' '}
          <span className="font-medium text-[var(--color-content-primary)]">{email}</span>. Click it
          to activate your account, then sign in with your password.
        </p>
        <button
          onClick={() => {
            setPasswordMode('signin');
            resetTo('password');
          }}
          className={LINK_CLASS}
        >
          Back to sign in
        </button>
      </div>
    );
  }

  // Email + password form
  if (step === 'password') {
    const isSignup = passwordMode === 'signup';
    return (
      <form onSubmit={handlePasswordSubmit} className="flex w-full max-w-xs flex-col gap-2.5">
        <label htmlFor="lk-email" className="sr-only">
          Email address
        </label>
        <input
          id="lk-email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className={FIELD_CLASS}
        />

        <label htmlFor="lk-password" className="sr-only">
          Password
        </label>
        <input
          id="lk-password"
          name="password"
          type="password"
          autoComplete={isSignup ? 'new-password' : 'current-password'}
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className={FIELD_CLASS}
        />

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS} aria-busy={busy}>
          <LockIcon className="size-4 shrink-0" />
          {busy
            ? isSignup
              ? 'Creating account...'
              : 'Signing in...'
            : isSignup
              ? 'Create account'
              : 'Sign in'}
        </button>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setPasswordMode(isSignup ? 'signin' : 'signup');
              setError('');
            }}
            className={LINK_CLASS}
          >
            {isSignup ? 'I already have an account' : 'Create an account'}
          </button>
          {!isSignup && (
            <Link href="/forgot-password" className={LINK_CLASS}>
              Forgot password?
            </Link>
          )}
        </div>

        <button type="button" onClick={() => resetTo('magic')} className={LINK_CLASS}>
          Email me a magic link instead
        </button>
        <button type="button" onClick={() => resetTo('idle')} className={LINK_CLASS}>
          Back
        </button>
      </form>
    );
  }

  // Magic-link email entry form
  if (step === 'magic') {
    return (
      <form onSubmit={handleMagicLinkSubmit} className="flex w-full max-w-xs flex-col gap-2.5">
        <label htmlFor="lk-magic-email" className="sr-only">
          Email address
        </label>
        <input
          id="lk-magic-email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className={FIELD_CLASS}
        />
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={PRIMARY_BUTTON_CLASS} aria-busy={busy}>
          <MailIcon className="size-4 shrink-0" />
          {busy ? 'Sending...' : 'Send magic link'}
        </button>
        <button type="button" onClick={() => resetTo('password')} className={LINK_CLASS}>
          Use a password instead
        </button>
        <button type="button" onClick={() => resetTo('idle')} className={LINK_CLASS}>
          Back
        </button>
      </form>
    );
  }

  // Default: GitHub + email options
  return (
    <div className="flex flex-col items-center gap-3">
      {/* Primary: GitHub */}
      <button
        onClick={handleGitHubLogin}
        disabled={loading}
        className="group relative flex h-12 min-w-[220px] items-center justify-center gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 text-sm font-semibold text-[var(--color-content-primary)] shadow-[0_0_0_1px_transparent] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] hover:shadow-[0_0_20px_var(--color-accent-glow)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        aria-busy={loading}
      >
        <GitHubIcon className="size-4 shrink-0" />
        {loading ? 'Redirecting...' : 'Continue with GitHub'}
      </button>

      {/* A failed OAuth initiation never navigates away, so this step has to be
          able to say so — the password and magic-link steps already do. */}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {/* Divider */}
      <div className="flex w-full max-w-[220px] items-center gap-2.5">
        <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
        <span className="text-xs text-[var(--color-content-tertiary)]">or</span>
        <span className="h-px flex-1 bg-[var(--color-border)]" aria-hidden />
      </div>

      {/* Secondary: email + password — kept clearly visible (elevated surface +
          primary text) so it reads as a real alternative, not a muted afterthought. */}
      <button
        onClick={() => {
          setPasswordMode('signin');
          resetTo('password');
        }}
        className="flex h-11 min-w-[220px] items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-6 text-sm font-medium text-[var(--color-content-primary)] transition-all duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        <LockIcon className="size-4 shrink-0" />
        Continue with email
      </button>

      {/* Tertiary: passwordless — still one tap away for anyone who prefers it. */}
      <button onClick={() => resetTo('magic')} className={LINK_CLASS}>
        Or email me a magic link
      </button>
    </div>
  );
}
