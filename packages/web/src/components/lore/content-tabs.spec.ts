import { describe, it, expect } from 'vitest';

import {
  CONTENT_TABS,
  DEFAULT_CONTENT_TAB,
  nextTabForKey,
  tabAfterSave,
  type ContentTab,
} from './content-tabs';

describe('content-tabs', () => {
  it('exposes exactly the two tabs in order', () => {
    expect(CONTENT_TABS).toEqual(['preview', 'edit']);
  });

  it('defaults to preview (requirement: Preview is the default tab)', () => {
    expect(DEFAULT_CONTENT_TAB).toBe('preview');
  });

  it('returns to preview after a save (requirement: save → back to Preview)', () => {
    expect(tabAfterSave()).toBe('preview');
  });

  describe('nextTabForKey — roving navigation', () => {
    it('moves forward on ArrowRight / ArrowDown, wrapping at the end', () => {
      expect(nextTabForKey('preview', 'ArrowRight')).toBe('edit');
      expect(nextTabForKey('preview', 'ArrowDown')).toBe('edit');
      // wrap: from the last tab forward → first
      expect(nextTabForKey('edit', 'ArrowRight')).toBe('preview');
    });

    it('moves backward on ArrowLeft / ArrowUp, wrapping at the start', () => {
      expect(nextTabForKey('edit', 'ArrowLeft')).toBe('preview');
      expect(nextTabForKey('edit', 'ArrowUp')).toBe('preview');
      // wrap: from the first tab backward → last
      expect(nextTabForKey('preview', 'ArrowLeft')).toBe('edit');
    });

    it('jumps to the ends on Home / End', () => {
      expect(nextTabForKey('edit', 'Home')).toBe('preview');
      expect(nextTabForKey('preview', 'End')).toBe('edit');
    });

    it('returns null for non-navigation keys so the caller can ignore them', () => {
      for (const key of ['Enter', ' ', 'a', 'Tab', 'Escape']) {
        expect(nextTabForKey('preview', key)).toBeNull();
      }
    });

    it('returns null when the current tab is not in the set', () => {
      expect(nextTabForKey('nope' as ContentTab, 'ArrowRight')).toBeNull();
    });
  });
});
