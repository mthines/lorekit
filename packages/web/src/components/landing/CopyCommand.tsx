'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { track, type CopySurface, type InstallCommandId } from '@/lib/analytics/track';

/**
 * A single-line, copyable terminal command shown on the public landing page's
 * "Get started" card. Mirrors the copy affordance of the dashboard's
 * `CopyableCode` (ClientConfigTabs) but sized for one inline command.
 *
 * ## Why the copy is tracked
 *
 * Copying `npx @lorekit/cli install` is the strongest intent signal a logged-out
 * visitor can produce short of authenticating — and, because the CLI works
 * offline with no account, it is a route to using the product that leaves no
 * other trace on the website at all. Without this event a visitor who read the
 * page, took the command and went to their terminal is indistinguishable from
 * one who bounced.
 *
 * `commandId` and `surface` are bounded ids rather than the command string,
 * which is arbitrary text and would become unbounded the moment a call site
 * interpolates something into it.
 */
export function CopyCommand({
  command,
  commandId,
  surface,
}: {
  command: string;
  /** Bounded id for telemetry — see `lib/analytics/track.ts`. */
  commandId: InstallCommandId;
  /** Where this affordance is rendered. */
  surface: CopySurface;
}) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    // Start from a resolved promise so a SYNCHRONOUS failure becomes a
    // rejection. `navigator.clipboard` is undefined in an insecure context and
    // `writeText` can be absent in a hardened browser, so calling it directly
    // throws before any promise exists — the `.catch` never ran and two of the
    // three failures this event was added to make visible went unrecorded.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(() => {
        track({ name: 'install_command.copied', commandId, surface, succeeded: true });
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard unavailable or denied — fail silently; the command text is
        // still visible and selectable.
        // Recorded rather than swallowed: a denied clipboard leaves the visitor
        // pressing a button that does nothing, and counting only the successes
        // would make that look like nobody was interested.
        track({ name: 'install_command.copied', commandId, surface, succeeded: false });
      });
  }

  return (
    <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] pl-3 pr-1.5 py-1.5">
      <code className="min-w-0 truncate font-mono text-xs text-[var(--color-accent)]">
        {command}
      </code>
      <button
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy command to clipboard'}
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-accent)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      >
        {copied
          ? <><Check className="size-3" aria-hidden /> Copied</>
          : <><Copy className="size-3" aria-hidden /> Copy</>}
      </button>
    </div>
  );
}
