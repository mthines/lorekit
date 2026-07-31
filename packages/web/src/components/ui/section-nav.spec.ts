import { describe, expect, it } from 'vitest';
import {
  activeSubItemId,
  isPanelTargeted,
  isSectionActive,
  shouldRevealSubItems,
  type SectionNavSubItem,
} from './section-nav';

const TWO: readonly SectionNavSubItem[] = [
  { id: 'account', label: 'Account' },
  { id: 'password', label: 'Password' },
];
const ONE: readonly SectionNavSubItem[] = [{ id: 'github-app', label: 'GitHub App' }];

describe('shouldRevealSubItems', () => {
  it('reveals sub-items only for the active section', () => {
    expect(shouldRevealSubItems(true, TWO)).toBe(true);
    expect(shouldRevealSubItems(false, TWO)).toBe(false);
  });

  it('never reveals a single sub-item — it would link to the page you are on', () => {
    expect(shouldRevealSubItems(true, ONE)).toBe(false);
  });

  it('handles sections with no sub-items at all', () => {
    expect(shouldRevealSubItems(true, undefined)).toBe(false);
    expect(shouldRevealSubItems(true, [])).toBe(false);
  });
});

describe('isSectionActive', () => {
  it('matches the exact route', () => {
    expect(isSectionActive('/settings/user', '/settings/user')).toBe(true);
  });

  it('matches nested routes', () => {
    expect(isSectionActive('/settings/user/sessions', '/settings/user')).toBe(true);
  });

  it('does not match a sibling with a shared prefix', () => {
    expect(isSectionActive('/settings/user-groups', '/settings/user')).toBe(false);
  });

  it('never marks an external item active', () => {
    expect(isSectionActive('/api-docs', '/api-docs', true)).toBe(false);
  });
});

describe('activeSubItemId', () => {
  it('falls back to the first sub-item when there is no fragment', () => {
    expect(activeSubItemId(TWO, '')).toBe('account');
  });

  it('matches a known fragment', () => {
    expect(activeSubItemId(TWO, 'password')).toBe('password');
  });

  it('highlights nothing for an unknown fragment', () => {
    expect(activeSubItemId(TWO, 'billing')).toBeNull();
  });

  it('returns null when there are no sub-items', () => {
    expect(activeSubItemId([], 'password')).toBeNull();
  });
});

describe('isPanelTargeted', () => {
  it('is true only when the fragment names the panel', () => {
    expect(isPanelTargeted('password', 'password')).toBe(true);
    expect(isPanelTargeted('account', 'password')).toBe(false);
  });

  it('is false for a panel with no anchor', () => {
    expect(isPanelTargeted('', undefined)).toBe(false);
    expect(isPanelTargeted('password', undefined)).toBe(false);
  });
});
