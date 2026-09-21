'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { track, type CopySurface, type InstallCommandId } from '@/lib/analytics/track';
import { cn } from '@/lib/cn';

/**
 * A single-line, copyable terminal command shown on the public landing page —
 * in the hero, where it is the primary call to action, and again in the
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
  size = 'sm',
}: {
  command: string;
  /** Bounded id for telemetry — see `lib/analytics/track.ts`. */
  commandId: InstallCommandId;
  /** Where this affordance is rendered. */
  surface: CopySurface;
  /**
   * `sm` is the inline form used inside a step list. `lg` is the hero form,
   * where this affordance IS the page's primary call to action: it gets a
   * 40px-tall copy control (WCAG 2.2 SC 2.5.8 asks for 24px — a primary CTA
   * should clear that comfortably) and body-sized command text.
   */
  size?: 'sm' | 'lg';
}) {
  const [copied, setCopied] = useState(false);
  const isLarge = size === 'lg';

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
    <div
      className={cn(
        'mt-1 flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]',
        isLarge ? 'py-2 pl-4 pr-2' : 'py-1.5 pl-3 pr-1.5',
      )}
    >
      <code
        className={cn(
          'min-w-0 truncate font-mono text-[var(--color-accent)]',
          isLarge ? 'text-sm' : 'text-xs',
        )}
      >
        {command}
      </code>
      <button
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy command to clipboard'}
        className={cn(
          // The label was `--color-content-tertiary`, which is 2.6:1 on this
          // surface — under the 4.5:1 floor for text at any size. Secondary is
          // 6.2:1 and reads as the same de-emphasised control.
          //
          // `active:scale` and nothing else: a transform stays on the
          // compositor, which is where press feedback has to run to land inside
          // the ~100ms window that still reads as instant.
          'flex shrink-0 items-center gap-1 rounded-md font-medium text-[var(--color-content-secondary)] transition-[color,background-color,transform] duration-150 ease-out hover:bg-[var(--color-bg-raised)] hover:text-[var(--color-accent)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
          isLarge ? 'min-h-10 px-3 text-xs' : 'px-2 py-1 text-[10px]',
        )}
      >
        {copied
          ? <><Check className={isLarge ? 'size-4' : 'size-3'} aria-hidden /> Copied</>
          : <><Copy className={isLarge ? 'size-4' : 'size-3'} aria-hidden /> Copy</>}
      </button>
    </div>
  );
}
