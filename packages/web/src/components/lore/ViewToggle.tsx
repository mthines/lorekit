'use client';

/**
 * List ⇄ Map — the Explorer's view switch.
 *
 * A segmented group rather than the {@link Combobox} the Status control uses,
 * and the difference is deliberate: status has three values each needing a
 * sentence of explanation and is changed rarely, so hiding the alternatives is
 * the right trade. A view switch is two values, self-evident from their icons,
 * and toggled constantly while exploring — the alternative must be one click
 * away, not two, and the current state must be readable without opening
 * anything.
 *
 * Marked up as a `radiogroup`, not a pair of buttons: the two options are
 * mutually exclusive states of one setting, which is what a radio group means
 * to a screen reader, and it gets arrow-key traversal for free from the
 * platform's roving-focus behaviour.
 */

import { List, Boxes } from 'lucide-react';
import type { LoreView } from '@/lib/lore-view';

const OPTIONS: readonly { value: LoreView; label: string; icon: typeof List }[] = [
  { value: 'list', label: 'List', icon: List },
  { value: 'map', label: 'Map', icon: Boxes },
];

interface ViewToggleProps {
  value: LoreView;
  onChange: (view: LoreView) => void;
}

export function ViewToggle({ value, onChange }: ViewToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Result view"
      className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-0.5"
    >
      {OPTIONS.map((option) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            // 32px tall with the padding — above the 24px WCAG 2.2 (2.5.8)
            // floor, and the label is always visible so the target is the
            // icon plus its word rather than the icon alone.
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
              selected
                ? 'bg-[var(--color-bg-elevated)] text-[var(--color-content-primary)]'
                : 'text-[var(--color-content-secondary)] hover:text-[var(--color-content-primary)]'
            }`}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
