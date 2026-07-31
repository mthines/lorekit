'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { motion, MotionConfig } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import { disclosurePanelProps, disclosureTriggerProps } from './disclosure';
import { isPanelTargeted } from './section-nav';
import { useHash } from '@/lib/hooks/useHash';

interface SectionPanelProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /**
   * Render the header as a disclosure trigger that shows/hides the body.
   *
   * For sections that are secondary to the page's main job — an occasional
   * task the user came for deliberately, not something they need to read.
   * Hick's Law: keep the default set of visible choices small and put the rest
   * behind one click.
   *
   * The header itself stays fully visible either way. A collapsed section is
   * *quiet*, never hidden — burying a control the user is looking for (a
   * security setting especially) trades one usability problem for a worse one.
   */
  collapsible?: boolean;
  /** Only meaningful with `collapsible`. Defaults to closed. */
  defaultOpen?: boolean;
  /**
   * Makes the panel an in-page anchor target (`#{anchorId}`), so a
   * {@link SectionNav} sub-item can jump to it. Must match the sub-item's `id`.
   *
   * A collapsible panel that is the current anchor target opens itself —
   * jumping someone to a collapsed header looks like a broken link. It never
   * closes on its own: navigating away from an anchor should not undo a
   * disclosure the user is reading.
   */
  anchorId?: string;
}

/**
 * Reusable titled content card: a bordered panel with an amber icon chip header
 * and a quick fade-up entrance. Pair with {@link SectionNav} so every section
 * across the app shares the same chrome and adding one is drop-in.
 *
 * With `collapsible`, the header becomes a disclosure trigger following the
 * same visual language as the Explorer's heatmap panel and the onboarding
 * checklist. The heading stays a real `<h2>` wrapping the button, so heading
 * navigation still lists the section when it is collapsed.
 */
export function SectionPanel({
  icon,
  title,
  subtitle,
  children,
  collapsible = false,
  defaultOpen = false,
  anchorId,
}: SectionPanelProps) {
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);

  const targeted = isPanelTargeted(useHash(), anchorId);
  useEffect(() => {
    if (targeted) setOpen(true);
  }, [targeted]);

  // A non-collapsible panel is always open; its body is a plain container with
  // no ARIA wiring, exactly as before.
  const expanded = collapsible ? open : true;

  const iconChip = (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-accent-glow)] bg-[var(--color-accent-subtle)] text-[var(--color-accent)]"
      aria-hidden
    >
      {icon}
    </div>
  );

  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        id={anchorId}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
        // `scroll-mt` keeps the header clear of the sticky app chrome when the
        // browser jumps to this panel.
        className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-raised)] scroll-mt-20"
      >
        {collapsible ? (
          // The border only separates the header from a body that is showing.
          <div className={expanded ? 'border-b border-[var(--color-border)]' : undefined}>
            <h2>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                {...disclosureTriggerProps(expanded, panelId)}
                className="flex w-full min-h-11 items-start gap-3 p-4 text-left transition-colors hover:bg-[var(--color-bg-elevated)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--color-accent)]"
              >
                {iconChip}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-[var(--color-content-primary)]">
                    {title}
                  </span>
                  {subtitle && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-content-secondary)]">
                      {subtitle}
                    </span>
                  )}
                </span>
                <ChevronDown
                  className={[
                    'mt-1 size-4 shrink-0 text-[var(--color-content-tertiary)] transition-transform duration-150',
                    expanded ? 'rotate-180' : '',
                  ].join(' ')}
                  aria-hidden
                />
              </button>
            </h2>
          </div>
        ) : (
          <div className="flex items-start gap-3 border-b border-[var(--color-border)] p-4">
            {iconChip}
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--color-content-primary)]">{title}</h2>
              {subtitle && (
                <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-content-secondary)]">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
        )}

        {collapsible ? (
          // Kept mounted and `hidden` rather than unmounted, so `aria-controls`
          // always resolves and a half-filled form survives a collapse.
          <div {...disclosurePanelProps(expanded, panelId)} className="p-4">
            {children}
          </div>
        ) : (
          <div className="p-4">{children}</div>
        )}
      </motion.section>
    </MotionConfig>
  );
}
