import { describe, it, expect } from 'vitest';
import { isPublished, draftsVisibleIn } from './publish';

const NOW = new Date('2026-08-15T12:00:00Z');

describe('isPublished', () => {
  it('publishes a post dated before today', () => {
    expect(isPublished('2026-08-08', NOW)).toBe(true);
  });

  it('publishes a post dated exactly today (UTC day boundary)', () => {
    expect(isPublished('2026-08-15', NOW)).toBe(true);
    // Early in the UTC day still counts as published — comparison is day-granular.
    expect(isPublished('2026-08-15', new Date('2026-08-15T00:00:01Z'))).toBe(true);
  });

  it('hides a future-dated post', () => {
    expect(isPublished('2026-12-01', NOW)).toBe(false);
    expect(isPublished('2026-08-16', NOW)).toBe(false);
  });

  it('ignores any time component on the frontmatter date', () => {
    // A full ISO datetime still compares by its UTC calendar day.
    expect(isPublished('2026-08-15T23:59:59Z', NOW)).toBe(true);
  });

  it('fails open on an unparseable date so a typo never buries a real post', () => {
    expect(isPublished('not-a-date', NOW)).toBe(true);
    expect(isPublished('', NOW)).toBe(true);
  });
});

describe('draftsVisibleIn', () => {
  it('hides drafts in production only', () => {
    expect(draftsVisibleIn('production')).toBe(false);
  });

  it('shows drafts on preview, development, and local', () => {
    expect(draftsVisibleIn('preview')).toBe(true);
    expect(draftsVisibleIn('development')).toBe(true);
    expect(draftsVisibleIn('local')).toBe(true);
  });
});
