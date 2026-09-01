'use client';

import { useState, useTransition } from 'react';
import {
  Copy, CheckCheck, Eye, EyeOff, KeyRound, ShieldAlert, ExternalLink, Clock,
} from 'lucide-react';
import { getSessionToken, type SessionToken } from '@/lib/session-token';
import { Button } from '@/components/ui/Button';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mask a token to its first ~12 and last ~6 chars for at-a-glance display. */
function maskToken(token: string): string {
  if (token.length <= 24) return token;
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

/**
 * Human-readable expiry from a unix-seconds timestamp, computed on the client
 * (this is a client component, so `Date.now()` is safe — no SSR hydration risk).
 * Returns a tuple of { text, expired } so the caller can style the expired case.
 */
function describeExpiry(expiresAt: number | null): { text: string; expired: boolean } {
  if (expiresAt == null) return { text: 'No expiry reported', expired: false };
  const msLeft = expiresAt * 1000 - Date.now();
  if (msLeft <= 0) return { text: 'Expired — reveal again for a fresh token', expired: true };

  const minutes = Math.round(msLeft / 60_000);
  const localTime = new Date(expiresAt * 1000).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  if (minutes < 60) return { text: `Expires in ~${minutes} min (at ${localTime})`, expired: false };
  const hours = Math.round(minutes / 60);
  return { text: `Expires in ~${hours} h (at ${localTime})`, expired: false };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SessionTokenPanel() {
  // null       → not revealed yet
  // 'signed-out' → server action returned null (no session)
  // SessionToken → revealed value
  const [session, setSession] = useState<SessionToken | 'signed-out' | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleReveal() {
    setCopied(false);
    startTransition(async () => {
      const result = await getSessionToken();
      // A fresh reveal shows the masked form again; the user opts back into full view.
      setVisible(false);
      setSession(result ?? 'signed-out');
    });
  }

  function handleCopy(token: string) {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  }

  const revealed = session !== null && session !== 'signed-out';
  const expiry = revealed ? describeExpiry(session.expiresAt) : null;

  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <div className="p-4">
        {/* Header */}
        <div className="mb-1 flex items-center gap-2">
          <KeyRound className="size-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
          <h3 className="text-sm font-semibold text-[var(--color-content-primary)]">
            Session token (JWT)
          </h3>
        </div>
        <p className="mb-3 text-xs text-[var(--color-content-secondary)]">
          Use this to test the JWT-authenticated endpoints (Orgs, Members, Invites) in the API
          reference — those routes reject <code className="font-mono">lk_*</code> tokens and accept
          only a Supabase session JWT.
        </p>

        {/* Reveal button — nothing is fetched or shown until the user asks */}
        {!revealed && session !== 'signed-out' && (
          <Button
            variant="secondary"
            size="lg"
            onClick={handleReveal}
            isLoading={pending}
            leftIcon={<Eye className="size-4" aria-hidden />}
          >
            Reveal session token
          </Button>
        )}

        {/* Signed-out fallback — should not happen on this authed page, but be total */}
        {session === 'signed-out' && (
          <p className="text-xs text-[var(--color-content-tertiary)]">
            Sign in to reveal your session token.
          </p>
        )}

        {/* Revealed token */}
        {revealed && (
          <div className="flex flex-col gap-3">
            {/* Token display */}
            <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg)] p-3">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-[var(--color-content-primary)] whitespace-nowrap">
                {visible ? session.token : maskToken(session.token)}
              </code>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setVisible((v) => !v)}
                  aria-label={visible ? 'Hide session token' : 'Show full session token'}
                  className="flex size-11 items-center justify-center rounded text-[var(--color-content-tertiary)] hover:text-[var(--color-content-secondary)]"
                >
                  {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
                <button
                  onClick={() => handleCopy(session.token)}
                  aria-label="Copy session token"
                  className="flex min-h-11 items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-subtle)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] transition-all duration-150 hover:bg-[var(--color-accent)] hover:text-[#000]"
                >
                  {copied ? <><CheckCheck className="size-3" /> Copied!</> : <><Copy className="size-3" /> Copy</>}
                </button>
              </div>
            </div>

            {/* Expiry */}
            <div
              className="flex items-center gap-1.5 text-xs"
              style={{ color: expiry!.expired ? 'var(--color-error)' : 'var(--color-content-secondary)' }}
            >
              <Clock className="size-3 shrink-0" aria-hidden />
              {expiry!.text}
            </div>

            {/* Re-reveal (fetches a fresh token) */}
            <button
              onClick={handleReveal}
              disabled={pending}
              className="self-start text-xs text-[var(--color-content-tertiary)] underline transition-colors hover:text-[var(--color-content-secondary)] disabled:opacity-50"
            >
              {pending ? 'Refreshing…' : 'Reveal a fresh token'}
            </button>
          </div>
        )}

        {/* Security warning */}
        <div className="mt-3 flex items-start gap-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-raised)] p-2.5">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--color-content-tertiary)]" aria-hidden />
          <p className="text-[11px] leading-relaxed text-[var(--color-content-tertiary)]">
            This is a short-lived secret equivalent to your login. Don&apos;t share it or paste it
            anywhere but the API reference — it expires automatically.
          </p>
        </div>

        {/* Deep link to the API reference */}
        <a
          href="/api-docs"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex min-h-11 items-center gap-1 text-sm font-medium text-[var(--color-accent)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          Open the API reference
          <ExternalLink className="size-4 shrink-0" aria-hidden />
        </a>
        <p className="mt-1 text-[11px] text-[var(--color-content-tertiary)]">
          Paste the token into the <span className="font-medium">Authorize</span> field there to try
          the JWT-authenticated endpoints.
        </p>
      </div>
    </div>
  );
}
