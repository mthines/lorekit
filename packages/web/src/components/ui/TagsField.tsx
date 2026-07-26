'use client';

/**
 * TagsField
 *
 * Reusable inline tag editor. Renders existing tags as removable chips and a
 * small inline input for adding new tags.
 *
 * ## UX
 * - Press Enter or comma to confirm a new tag.
 * - Press Backspace on an empty input to delete the last tag.
 * - Click the × on any chip to remove it.
 * - Tab from the tag input moves to the next focusable element (accessible).
 *
 * ## Animation
 * New tags appear with a subtle scale + fade entrance (150 ms). Removed tags
 * exit with a fade-out (100 ms). Uses Motion's AnimatePresence.
 * `prefers-reduced-motion` is respected via the global CSS rule.
 *
 * ## Reusability
 * Fully controlled: accepts `tags` + `onChange(tags)`. No form coupling.
 * Compatible with react-hook-form's `Controller`.
 *
 * @example
 * ```tsx
 * <Controller
 *   name="tags"
 *   control={form.control}
 *   render={({ field }) => (
 *     <TagsField
 *       label="Tags"
 *       tags={field.value}
 *       onChange={field.onChange}
 *     />
 *   )}
 * />
 * ```
 */

import { useState, useRef, useCallback, useId } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, Tag } from 'lucide-react';

export interface TagsFieldProps {
  /** Section label shown as a heading. */
  label?: string;
  /** Controlled list of tag strings. */
  tags: string[];
  /** Called with the updated tag list on any change. */
  onChange: (tags: string[]) => void;
  /** Whether the field is editable. @default true */
  editable?: boolean;
  /** Placeholder text for the add-tag input. @default 'Add tag…' */
  placeholder?: string;
  /** Max number of tags. @default 20 */
  maxTags?: number;
  /** Optional class applied to the root wrapper. */
  className?: string;
}

export function TagsField({
  label = 'Tags',
  tags,
  onChange,
  editable = true,
  placeholder = 'Add tag…',
  maxTags = 20,
  className = '',
}: TagsFieldProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const headingId = useId();

  const addTag = useCallback(
    (raw: string) => {
      const tag = raw.trim().toLowerCase().replace(/,/g, '');
      if (!tag || tags.includes(tag) || tags.length >= maxTags) return;
      onChange([...tags, tag]);
      setInputValue('');
    },
    [tags, onChange, maxTags],
  );

  const removeTag = useCallback(
    (index: number) => {
      onChange(tags.filter((_, i) => i !== index));
    },
    [tags, onChange],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'Enter' || e.key === ',') && inputValue.trim()) {
      e.preventDefault();
      addTag(inputValue);
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  }

  return (
    <section aria-labelledby={headingId} className={['flex flex-col gap-2', className].join(' ')}>
      <h2
        id={headingId}
        className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-content-tertiary)]"
      >
        <Tag className="size-3" aria-hidden />
        {label}
      </h2>

      {/* Tag chips + input */}
      <div
        role="group"
        aria-label={`${label} chips`}
        className={[
          'flex min-h-10 flex-wrap gap-1.5 rounded-lg border p-2.5',
          editable
            ? 'border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-accent)] transition-colors duration-150 cursor-text'
            : 'border-transparent bg-transparent',
        ].join(' ')}
        // Clicking the container focuses the input for easy tag entry.
        onClick={() => editable && inputRef.current?.focus()}
      >
        <AnimatePresence initial={false} mode="popLayout">
          {tags.map((tag, i) => (
            <motion.span
              key={tag}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-2 py-0.5 font-mono text-xs text-[var(--color-content-secondary)]"
            >
              {tag}
              {editable && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTag(i);
                  }}
                  aria-label={`Remove tag ${tag}`}
                  className="ml-0.5 flex size-3.5 items-center justify-center rounded text-[var(--color-content-tertiary)] hover:text-[var(--color-content-primary)] transition-colors duration-100"
                >
                  <X className="size-2.5" aria-hidden />
                </button>
              )}
            </motion.span>
          ))}
        </AnimatePresence>

        {/* Add-tag input — only in edit mode */}
        {editable && tags.length < maxTags && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (inputValue.trim()) addTag(inputValue);
            }}
            placeholder={tags.length === 0 ? placeholder : ''}
            aria-label="Add a new tag"
            className="min-w-20 flex-1 bg-transparent text-xs text-[var(--color-content-primary)] placeholder:text-[var(--color-content-tertiary)] focus:outline-none"
          />
        )}

        {/* Hint when no tags and not editable */}
        {!editable && tags.length === 0 && (
          <span className="text-xs text-[var(--color-content-tertiary)]">No tags</span>
        )}
      </div>

      {/* Tag limit hint */}
      {editable && tags.length >= maxTags && (
        <p className="text-xs text-[var(--color-content-tertiary)]">
          Maximum of {maxTags} tags reached.
        </p>
      )}
    </section>
  );
}
