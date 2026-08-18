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
 * to a screen reader.
 *
 * The keyboard half of that promise has to be written by hand. `role="radio"`
 * on a `<button>` buys the SEMANTICS and nothing else — the platform gives
 * roving focus and arrow-key traversal only to real `<input type="radio">`
 * elements, so a group of buttons stays individually tabbable and ignores the
 * arrow keys, which is exactly what APG's radio-group pattern forbids. Hence
 * the `tabIndex` below (one stop for the whole group, on the checked option)
 * and the `onKeyDown` that moves selection with the arrows, Home and End.
 */

import { useRef, type KeyboardEvent } from 'react';
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

/**
 * The index the arrow keys move to, or `null` when the key is not ours.
 *
 * Both arrow axes are wired because the group is visually horizontal but a
 * screen-reader user navigating it has no way to know that — APG's radio-group
 * pattern treats Up/Left and Down/Right as the same pair of moves.
 */
function nextIndex(key: string, current: number, length: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % length;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}

export function ViewToggle({ value, onChange }: ViewToggleProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    OPTIONS.findIndex((option) => option.value === value),
    0,
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = nextIndex(event.key, selectedIndex, OPTIONS.length);
    if (target === null) return;
    event.preventDefault();
    // Selection follows focus, which is the APG default for a radio group and
    // the right call here: switching view is cheap, reversible, and the whole
    // point of the control.
    onChange(OPTIONS[target].value);
    buttons.current[target]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Result view"
      onKeyDown={handleKeyDown}
      className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-raised)] p-0.5"
    >
      {OPTIONS.map((option, index) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: Tab reaches the group once and lands on the
            // current choice, then the arrows move within it.
            tabIndex={index === selectedIndex ? 0 : -1}
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
