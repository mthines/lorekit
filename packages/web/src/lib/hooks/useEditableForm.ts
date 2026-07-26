'use client';

/**
 * useEditableForm
 *
 * Reusable react-hook-form wrapper for inline-edit surfaces (sidebar, detail
 * panels, etc.). Handles:
 *
 * - Initialising the form from an external value (e.g. the open lesson).
 * - Detecting "dirty" state (form differs from the last-saved/reset value).
 * - Providing a `save` handler (async, tracks pending/error state).
 * - Providing a `discard` handler (resets to the last saved values).
 * - Keyboard shortcut: Cmd/Ctrl+S → save; Escape while dirty → discard.
 *
 * ## Testability
 * The hook has no DOM or context dependencies — pass it a `onSave` callback
 * and initial values and test it with `renderHook` + `act`. The keyboard
 * listener is installed only when `enableKeyboard` is true (default), so
 * keyboard behaviour can be disabled in unit tests.
 *
 * ## Reusability
 * The hook is agnostic to the shape of `T`. It works for any form that can be
 * serialised as a plain object. The caller supplies `defaultValues` and a
 * `resolver` (optional) for validation.
 *
 * @example
 * ```ts
 * const form = useEditableForm({
 *   defaultValues: { value: lesson.value, tags: lesson.tags },
 *   onSave: async (data) => {
 *     const result = await updateLesson(lesson.scope, lesson.key, data);
 *     if (result.error) return result.error;
 *   },
 * });
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm, type DefaultValues, type FieldValues, type Resolver, type UseFormReturn } from 'react-hook-form';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseEditableFormOptions<T extends FieldValues> {
  /**
   * Initial field values. When this reference changes (e.g. when the user
   * opens a different lesson) the form resets automatically.
   */
  defaultValues: DefaultValues<T>;
  /**
   * Called when the user submits the form (Save button or Cmd+S).
   * Return a string to set it as the server-side error message, or void/undefined
   * on success.
   */
  onSave: (data: T) => Promise<string | undefined | void>;
  /**
   * Optional resolver for schema validation (zod, yup, etc.).
   */
  resolver?: Resolver<T>;
  /**
   * Install Cmd/Ctrl+S (save) and Escape (discard when dirty) keyboard handlers.
   * @default true
   */
  enableKeyboard?: boolean;
  /**
   * Called after a successful save so the parent can close the panel or
   * refresh its list.
   */
  onSaveSuccess?: () => void;
  /**
   * Called when the user discards changes (Escape key or Discard button).
   */
  onDiscard?: () => void;
}

export interface UseEditableFormReturn<T extends FieldValues> {
  /** The underlying react-hook-form instance. Spread onto your <form>. */
  form: UseFormReturn<T>;
  /** True while the async save is in flight. */
  isSaving: boolean;
  /** Server-side error returned from `onSave`, or null. */
  saveError: string | null;
  /**
   * True when the form values differ from the last reset/saved values.
   * Use this to show/hide the action bar.
   */
  isDirty: boolean;
  /** Submit handler — wire to `<form onSubmit={handleSubmit}>`. */
  handleSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
  /** Reset to the last saved values and clear the server error. */
  discard: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useEditableForm<T extends FieldValues>({
  defaultValues,
  onSave,
  resolver,
  enableKeyboard = true,
  onSaveSuccess,
  onDiscard,
}: UseEditableFormOptions<T>): UseEditableFormReturn<T> {
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const form = useForm<T>({
    defaultValues,
    resolver,
    // Validate on change so errors are immediate as the user types.
    mode: 'onChange',
  });

  const { formState, reset, handleSubmit: rhfHandleSubmit, watch } = form;

  // isDirty is a derived value — react-hook-form tracks it via formState.isDirty
  // but we also gate on !isSaving so the bar doesn't flicker during submission.
  const isDirty = formState.isDirty && !isSaving;

  // Track the default values ref so we can reset when the lesson changes.
  const defaultValuesRef = useRef(defaultValues);
  useEffect(() => {
    // If the shape of defaultValues changes (user opens a different lesson),
    // reset the form to the new defaults. Shallow-compare the serialised form
    // to avoid spurious resets when a re-render produces a new object with the
    // same values.
    const prev = JSON.stringify(defaultValuesRef.current);
    const next = JSON.stringify(defaultValues);
    if (prev !== next) {
      defaultValuesRef.current = defaultValues;
      setSaveError(null);
      reset(defaultValues as T);
    }
  }, [defaultValues, reset]);

  const discard = useCallback(() => {
    setSaveError(null);
    reset(defaultValuesRef.current as T);
    onDiscard?.();
  }, [reset, onDiscard]);

  const handleSubmit = rhfHandleSubmit(async (data) => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const error = await onSave(data);
      if (error) {
        setSaveError(error);
      } else {
        // Update the reset baseline so isDirty returns to false after a
        // successful save without needing a props change from the parent.
        defaultValuesRef.current = data as unknown as DefaultValues<T>;
        reset(data, { keepValues: true });
        onSaveSuccess?.();
      }
    } finally {
      setIsSaving(false);
    }
  });

  // Keyboard shortcuts: Cmd/Ctrl+S → save; Escape → discard (when dirty).
  useEffect(() => {
    if (!enableKeyboard) return;

    function onKeyDown(e: KeyboardEvent) {
      const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      if (modKey && e.key === 's') {
        e.preventDefault();
        if (isDirty) void handleSubmit();
      }

      if (e.key === 'Escape' && isDirty) {
        // Only discard on Escape when focus is inside the form — avoid
        // clobbering the sidebar's own close-on-Escape handler when the
        // form is clean.
        e.stopPropagation();
        discard();
      }
    }

    document.addEventListener('keydown', onKeyDown, { capture: true });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true });
    // watch is included to re-subscribe when field values change so the Escape
    // handler sees the current isDirty value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enableKeyboard, isDirty, handleSubmit, discard, watch]);

  return { form, isSaving, saveError, isDirty, handleSubmit, discard };
}
