import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';

/**
 * The rendered-in-browser half of the RFC 6749 §4.1.2.1 error split.
 *
 * Used only for failures discovered BEFORE the redirect_uri was validated
 * against a registered client — at that point there is no trustworthy place to
 * send the user, so the error has to be shown here. The copy is deliberately
 * plain about the fact that nothing was authorized: a consent screen that
 * fails ambiguously is a phishing surface.
 */
export function AuthorizeError({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] p-6">
      <div className="w-full max-w-md rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="mb-4 flex items-center gap-3">
          <ShieldAlert className="size-5 shrink-0 text-[var(--color-scope-branch)]" aria-hidden />
          <h1 className="font-mono text-sm font-semibold text-[var(--color-text)]">{title}</h1>
        </div>
        <p className="text-sm leading-relaxed text-[var(--color-text-muted)]">{detail}</p>
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          No access was granted and no token was issued.
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-[var(--color-border)] px-4 font-mono text-xs text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-hover)]"
        >
          Go to dashboard
        </Link>
      </div>
    </main>
  );
}
