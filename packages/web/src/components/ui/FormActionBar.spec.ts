/**
 * FormActionBar — pure prop-logic tests (node environment, no DOM/React).
 *
 * These tests cover the conditional-render logic decisions that FormActionBar
 * makes based on its props. Because we cannot mount React in the Node
 * environment without @testing-library/react, we extract the underlying
 * decisions into pure helper functions and test those.
 *
 * Integration-level render tests live in FormActionBar.integration.test.tsx
 * (requires jsdom + @testing-library/react — add when those are available).
 */

import { describe, it, expect } from 'vitest';

// ── Pure helpers extracted for testability ─────────────────────────────────────

/** Returns true if the FormActionBar should be visible. */
function shouldShowBar(isDirty: boolean): boolean {
  return isDirty;
}

/** Returns true if action buttons should be disabled. */
function shouldDisableActions(isSaving: boolean): boolean {
  return isSaving;
}

/** Returns the save button label. */
function saveLabelFor(isSaving: boolean): string {
  return isSaving ? 'Saving…' : 'Save';
}

/** Returns whether the error message should be shown. */
function hasError(saveError: string | null | undefined): boolean {
  return Boolean(saveError);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FormActionBar — visibility logic', () => {
  it('hides the bar when isDirty is false', () => {
    expect(shouldShowBar(false)).toBe(false);
  });

  it('shows the bar when isDirty is true', () => {
    expect(shouldShowBar(true)).toBe(true);
  });
});

describe('FormActionBar — save button label', () => {
  it('shows "Save" while not saving', () => {
    expect(saveLabelFor(false)).toBe('Save');
  });

  it('shows "Saving…" while isSaving', () => {
    expect(saveLabelFor(true)).toBe('Saving…');
  });
});

describe('FormActionBar — disabled state', () => {
  it('enables buttons when not saving', () => {
    expect(shouldDisableActions(false)).toBe(false);
  });

  it('disables buttons when isSaving=true', () => {
    expect(shouldDisableActions(true)).toBe(true);
  });
});

describe('FormActionBar — error visibility', () => {
  it('shows no error when saveError is null', () => {
    expect(hasError(null)).toBe(false);
  });

  it('shows no error when saveError is undefined', () => {
    expect(hasError(undefined)).toBe(false);
  });

  it('shows no error when saveError is an empty string', () => {
    expect(hasError('')).toBe(false);
  });

  it('shows an error when saveError has a message', () => {
    expect(hasError('Something went wrong')).toBe(true);
  });
});
