export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name — required since the pill has no visible label of its own. */
  label: string;
  className?: string;
}

/**
 * A reusable on/off pill switch (`role="switch"`).
 *
 * The thumb is pinned with an explicit `left-0.5` rather than relying on the
 * browser's default static-position for an absolutely-positioned child: some
 * browsers give `<button>` an internal flex layout that centers an
 * unpositioned absolute child instead of anchoring it to the start, which
 * pushes the thumb toward — and, once translated for the checked state,
 * past — the right edge. Pinning `left-0.5` makes the `off`/`on` positions
 * (`translate-x-0` / `translate-x-[18px]`) unambiguous regardless of that
 * default.
 */
export function Switch({ checked, onChange, label, className = '' }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={[
        'relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]',
        className,
      ].join(' ')}
    >
      <span
        className={[
          'absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        ].join(' ')}
        aria-hidden
      />
    </button>
  );
}
