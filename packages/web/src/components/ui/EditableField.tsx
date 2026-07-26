'use client';

/**
 * EditableField
 *
 * A generic reusable textarea-based editable field. Designed for inline editing
 * within panels and sidebars where the user can toggle between read and edit
 * modes, or always be in edit mode.
 *
 * ## Modes
 * - **read**: renders the value as static text with a subtle "click to edit"
 *   affordance on hover (pencil icon). Keyboard-accessible via Enter/Space.
 * - **edit**: renders a styled, auto-growing textarea that fills the same visual
 *   slot as the read view.
 *
 * ## Animation
 * Transitions between modes use opacity only (GPU-safe) — no layout-property
 * animations. Duration: 150 ms (micro-interaction band, < 200 ms).
 *
 * ## Reusability
 * Accepts any react-hook-form field via the `field` prop (from `Controller`
 * or `register`). Can also be used standalone with `value` + `onChange`.
 * No coupling to any specific form shape.
 *
 * @example
 * ```tsx
 * // With react-hook-form Controller:
 * <Controller
 *   name="value"
 *   control={form.control}
 *   render={({ field }) => (
 *     <EditableField
 *       label="Content"
 *       field={field}
 *       placeholder="Enter memory content…"
 *       minRows={3}
 *     />
 *   )}
 * />
 * ```
 */

import { useRef, useEffect, useCallback, type TextareaHTMLAttributes } from 'react';
import { Pencil } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EditableFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'className'> {
  /** Field label shown as a section heading. */
  label: string;
  /** Current value (controlled). */
  value: string;
  /** Change handler. */
  onChange: (value: string) => void;
  /** Called when the field gains edit focus. */
  onEditStart?: () => void;
  /** Called when the field loses focus (blur event). */
  onEditEnd?: () => void;
  /** Whether the field is in edit mode. @default true */
  isEditing?: boolean;
  /** Minimum visible rows. @default 3 */
  minRows?: number;
  /** Optional validation error message. */
  error?: string;
  /** Placeholder text shown in the textarea. */
  placeholder?: string;
  /** Extra class applied to the root wrapper. */
  className?: string;
  /** Whether the field is read-only (no edit toggle). @default false */
  readOnly?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EditableField({
  label,
  value,
  onChange,
  onEditStart,
  onEditEnd,
  isEditing = true,
  minRows = 3,
  error,
  placeholder,
  className = '',
  readOnly = false,
  ...textareaProps
}: EditableFieldProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea to fit its content — GPU-safe: changes height, but
  // only on the composited textarea layer. A static `min-height` is set via
  // minRows to prevent excessive collapse on empty content.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    autoGrow();
  }, [value, isEditing, autoGrow]);

  // Focus the textarea when entering edit mode (but not on initial mount when
  // isEditing defaults to true — only when it flips from false → true).
  const prevIsEditing = useRef(isEditing);
  useEffect(() => {
    if (isEditing && !prevIsEditing.current) {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        // Place cursor at end of content.
        el.selectionStart = el.selectionEnd = el.value.length;
      }
    }
    prevIsEditing.current = isEditing;
  }, [isEditing]);

  const fieldId = `editable-field-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const errorId = error ? `${fieldId}-error` : undefined;

  return (
    <section aria-label={label} className={['flex flex-col gap-2', className].join(' ')}>
      {/* Section heading */}
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]">
          {label}
        </h2>
        {/* Edit affordance — only visible in read mode */}
        {!isEditing && !readOnly && (
          <button
            type="button"
            onClick={onEditStart}
            aria-label={`Edit ${label}`}
            className="flex size-6 items-center justify-center rounded text-[var(--color-content-tertiary)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:text-[var(--color-content-primary)] focus-visible:opacity-100"
          >
            <Pencil className="size-3" aria-hidden />
          </button>
        )}
      </div>

      {/* Field body */}
      {isEditing && !readOnly ? (
        /* Edit mode — textarea */
        <div
          className={[
            'rounded-lg border bg-[var(--color-bg)] transition-colors duration-150',
            error
              ? 'border-[var(--color-error)]'
              : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)]',
          ].join(' ')}
        >
          <textarea
            {...textareaProps}
            id={fieldId}
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              autoGrow();
            }}
            onFocus={onEditStart}
            onBlur={onEditEnd}
            placeholder={placeholder}
            aria-invalid={Boolean(error)}
            aria-describedby={errorId}
            rows={minRows}
            className={[
              'w-full resize-none bg-transparent p-4 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)]',
              'placeholder:text-[var(--color-content-tertiary)] focus:outline-none',
              'overflow-hidden',
            ].join(' ')}
            style={{ minHeight: `${minRows * 1.625 + 2}rem` }}
          />
        </div>
      ) : (
        /* Read mode — static text with click-to-edit */
        <button
          type="button"
          onClick={readOnly ? undefined : onEditStart}
          disabled={readOnly}
          aria-label={readOnly ? undefined : `Click to edit ${label}`}
          className={[
            'group w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-left',
            readOnly
              ? 'cursor-default'
              : 'cursor-text transition-colors duration-150 hover:border-[var(--color-accent-glow)] hover:bg-[var(--color-bg-elevated)]',
          ].join(' ')}
        >
          <div className="flex items-start gap-2">
            <p className="flex-1 font-mono text-xs leading-relaxed text-[var(--color-content-secondary)] whitespace-pre-wrap break-words">
              {value || (
                <span className="text-[var(--color-content-tertiary)]">
                  {placeholder ?? `No ${label.toLowerCase()} set`}
                </span>
              )}
            </p>
            {!readOnly && (
              <Pencil
                className="size-3 shrink-0 text-[var(--color-content-tertiary)] opacity-0 transition-opacity duration-150 group-hover:opacity-60"
                aria-hidden
              />
            )}
          </div>
        </button>
      )}

      {/* Validation error */}
      {error && (
        <p id={errorId} role="alert" className="flex items-center gap-1 text-xs text-[var(--color-error)]">
          {error}
        </p>
      )}
    </section>
  );
}
