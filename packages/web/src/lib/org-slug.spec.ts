import { describe, it, expect } from 'vitest';
import { normalizeSlug } from './org-slug';

describe('normalizeSlug', () => {
  it('returns the lowercased slug for valid lowercase input', () => {
    expect(normalizeSlug('acme-org')).toBe('acme-org');
  });

  it('lowercases valid uppercase or mixed-case input', () => {
    expect(normalizeSlug('Acme-Org')).toBe('acme-org');
    expect(normalizeSlug('ACME123')).toBe('acme123');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeSlug('  acme-org  ')).toBe('acme-org');
  });

  it('accepts digits and dashes', () => {
    expect(normalizeSlug('team-42')).toBe('team-42');
  });

  it('returns null for empty input', () => {
    expect(normalizeSlug('')).toBeNull();
    expect(normalizeSlug('   ')).toBeNull();
  });

  it('returns null when a segment contains internal whitespace', () => {
    expect(normalizeSlug('acme org')).toBeNull();
  });

  it('returns null for a slash (not a single segment)', () => {
    expect(normalizeSlug('acme/org')).toBeNull();
  });

  it('returns null for underscores or dots (slug allows only [a-z0-9-])', () => {
    expect(normalizeSlug('acme_org')).toBeNull();
    expect(normalizeSlug('acme.org')).toBeNull();
  });

  it('returns null when shorter than the minimum length', () => {
    expect(normalizeSlug('a')).toBeNull();
  });

  it('returns null when longer than the maximum length', () => {
    expect(normalizeSlug('a'.repeat(49))).toBeNull();
  });

  it('accepts a slug at exactly the maximum length', () => {
    expect(normalizeSlug('a'.repeat(48))).toBe('a'.repeat(48));
  });
});
