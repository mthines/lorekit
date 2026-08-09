import { describe, it, expect } from 'vitest';

import {
  CONTENT_TABS,
  CONTENT_TAB_SHORTCUT_KEYS,
  DEFAULT_CONTENT_TAB,
  nextTabForKey,
  shortcutTabForKey,
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

  describe('shortcutTabForKey — P/E global shortcuts', () => {
    const base = { hasModifier: false, inFormField: false, canEdit: true };

    it('maps p → preview and e → edit (case-insensitive)', () => {
      expect(shortcutTabForKey('p', base)).toBe('preview');
      expect(shortcutTabForKey('P', base)).toBe('preview');
      expect(shortcutTabForKey('e', base)).toBe('edit');
      expect(shortcutTabForKey('E', base)).toBe('edit');
    });

    it('never fires while focus is in a form field (typing p/e must not switch)', () => {
      expect(shortcutTabForKey('p', { ...base, inFormField: true })).toBeNull();
      expect(shortcutTabForKey('e', { ...base, inFormField: true })).toBeNull();
    });

    it('never fires when a command modifier is held', () => {
      expect(shortcutTabForKey('e', { ...base, hasModifier: true })).toBeNull();
      expect(shortcutTabForKey('p', { ...base, hasModifier: true })).toBeNull();
    });

    it('suppresses e (edit) when editing is disabled, but still allows p', () => {
      expect(shortcutTabForKey('e', { ...base, canEdit: false })).toBeNull();
      expect(shortcutTabForKey('p', { ...base, canEdit: false })).toBe('preview');
    });

    it('ignores any other key', () => {
      for (const key of ['a', 'x', 'Enter', ' ', 'Escape']) {
        expect(shortcutTabForKey(key, base)).toBeNull();
      }
    });

    it('honours exactly the keys it announces via aria-keyshortcuts', () => {
      for (const tab of CONTENT_TABS) {
        expect(shortcutTabForKey(CONTENT_TAB_SHORTCUT_KEYS[tab], base)).toBe(tab);
      }
    });

    it('stops honouring the Edit key when editing is disabled (so the tab must stop announcing it)', () => {
      expect(shortcutTabForKey(CONTENT_TAB_SHORTCUT_KEYS.edit, { ...base, canEdit: false })).toBeNull();
      expect(shortcutTabForKey(CONTENT_TAB_SHORTCUT_KEYS.preview, { ...base, canEdit: false })).toBe(
        'preview',
      );
    });
  });
});
