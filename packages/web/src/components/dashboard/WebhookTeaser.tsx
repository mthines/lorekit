'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { X, Webhook, ArrowRight } from 'lucide-react';
import { useOnboarding } from '@/components/providers/OnboardingProvider';

const WEBHOOK_TEASER_DISMISSED_KEY = 'lorekit:webhook-teaser-dismissed';

interface WebhookTeaserProps {
  /**
   * Whether the server has already seen a `source::pr-webhook` lesson — i.e.
   * the webhook is active and delivering. When true, the teaser is irrelevant
   * and renders nothing. Passed from the RSC so the teaser never needs to
   * re-derive it client-side.
   */
  hasWebhook: boolean;
}

/**
 * WebhookTeaser — a lightweight, dismissible discovery card shown on the
 * Overview once the user has connected an agent (connect step done) but
 * before they have set up the GitHub webhook (hasWebhook is false).
 *
 * Design rationale (UX review, July 2026):
 * - The webhook is an optional enrichment feature, not a mandatory setup step.
 *   Presenting it as a peer of "Connect your agent" creates a false mandate
 *   and inflates the perceived setup cost for new users.
 * - Progressive disclosure: show the value proposition at the moment of peak
 *   attention (right after the first success), then hand off to Settings where
 *   the full configuration UI already lives.
 * - Independent dismiss: the card disappears on its own and never blocks
 *   `allDone` — the onboarding checklist completes as soon as an agent connects.
 */
export function WebhookTeaser({ hasWebhook }: WebhookTeaserProps) {
  const { isServerDone, hydrated } = useOnboarding();
  const [dismissed, setDismissed] = useState(false);
  const [localHydrated, setLocalHydrated] = useState(false);

  // Read persisted dismiss state after mount to avoid SSR/hydration mismatch.
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(WEBHOOK_TEASER_DISMISSED_KEY) === '1');
    } catch {
      // Ignore — defaults to visible.
    }
    setLocalHydrated(true);
  }, []);

  // Show only when:
  // 1. The main onboarding provider has hydrated (so isServerDone is stable).
  // 2. The local localStorage has been read (so dismissed state is accurate).
  // 3. The connect step is done (agent has written at least one lesson).
  // 4. The user hasn't dismissed this teaser.
  // 5. The webhook hasn't already fired (passed from server).
  const connectDone = isServerDone('connect');

  // Wait for both hydration passes before rendering.
  if (!hydrated || !localHydrated) return null;
  // Already has webhook data flowing in — teaser is no longer relevant.
  if (hasWebhook) return null;
  // Agent hasn't connected yet — too early to show the upsell.
  if (!connectDone) return null;
  // User dismissed it.
  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(WEBHOOK_TEASER_DISMISSED_KEY, '1');
    } catch {
      /* best-effort */
    }
  }

  return (
    <div className="relative rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-4">
      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        aria-label="Dismiss webhook suggestion"
        title="Dismiss"
        className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-[var(--color-content-tertiary)] transition-colors duration-150 hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-content-secondary)]"
      >
        <X className="size-3.5" aria-hidden />
      </button>

      <div className="flex items-start gap-3 pr-8">
        {/* Icon */}
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-content-secondary)]">
          <Webhook className="size-4" aria-hidden />
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--color-content-primary)]">
            Auto-memories from PR reviews
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-content-tertiary)]">
            Connect a GitHub webhook and every resolved review comment becomes a
            memory automatically — no manual writes needed.
          </p>

          <Link
            href="/settings/webhooks"
            className="group mt-3 inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs font-medium text-[var(--color-content-secondary)] transition-colors duration-150 hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Set up in Settings
            <ArrowRight
              className="size-3 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden
            />
          </Link>
        </div>
      </div>
    </div>
  );
}
