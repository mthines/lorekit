'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { Copy, CheckCheck, ShieldAlert, Loader2, Eye, EyeOff, Clock, ArrowUpRight } from 'lucide-react';
import { getSessionToken } from '@/lib/session-token';

const BUTTON_CLASS =
  'flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-4 text-sm font-medium text-[var(--color-content-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50';

function expiryLabel(expiresAt: number | null): string | null {
  if (!expiresAt) return null;
  const minutes = Math.round((expiresAt * 1000 - Date.now()) / 60_000);
  if (minutes <= 0) return 'expired — reveal again for a fresh one';
  if (minutes < 60) return `expires in ~${minutes} min`;
  return `expires in ~${Math.round(minutes / 60)} h`;
}

/**
 * Reveals the caller's Supabase session JWT for testing the JWT-only endpoints
 * (Orgs / Members / Invites) in /api-docs — see `getSessionToken`. The token is
 * never rendered until the user clicks; on reveal it is copied to the clipboard
 * and shown (masked by default) so they can copy it again if the clipboard write
 * was blocked.
 */
export function SessionTokenPanel() {
  const [pending, startTransition] = useTransition();
  const [token, setToken] = useState('');
  const [expiry, setExpiry] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  function reveal() {
    setError('');
    startTransition(async () => {
      const result = await getSessionToken();
      if ('error' in result) {
        setError(result.error);
        return;
      }
      setToken(result.token);
      setExpiry(expiryLabel(result.expiresAt));
      try {
        await navigator.clipboard.writeText(result.token);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard blocked (permissions / insecure context) — the revealed
        // field below lets the user select and copy manually.
        setCopied(false);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-start gap-2 text-xs text-[var(--color-content-secondary)]">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]" aria-hidden />
        <span>
          The Orgs, Members and Invites endpoints need a Supabase session token, not an{' '}
          <code className="font-mono text-[var(--color-content-primary)]">lk_*</code> API key. This
          is a short-lived credential scoped to your account — treat it like a password and don&apos;t
          share it.
        </span>
      </p>

      <button type="button" onClick={reveal} disabled={pending} aria-busy={pending} className={BUTTON_CLASS}>
        {pending ? (
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
        ) : copied ? (
          <CheckCheck className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
        ) : (
          <Copy className="size-4 shrink-0" aria-hidden />
        )}
        {pending ? 'Revealing…' : copied ? 'Copied to clipboard' : token ? 'Copy again' : 'Reveal & copy access token'}
      </button>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      {token && (
        <div className="flex flex-col gap-1.5">
          <div className="relative">
            <textarea
              readOnly
              value={revealed ? token : '•'.repeat(48)}
              rows={2}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-3 pr-12 font-mono text-xs break-all text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            />
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? 'Hide token' : 'Show token'}
              className="absolute top-0 right-0 flex w-11 items-center justify-center py-3 text-[var(--color-content-tertiary)] transition-colors hover:text-[var(--color-content-primary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)]"
            >
              {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          {expiry && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--color-content-tertiary)]">
              <Clock className="size-3 shrink-0" aria-hidden />
              {expiry}
            </p>
          )}
        </div>
      )}

      <Link
        href="/api-docs"
        className="inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--color-accent)] transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
      >
        Open the API reference
        <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
      </Link>
    </div>
  );
}
