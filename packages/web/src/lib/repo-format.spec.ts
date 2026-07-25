import { describe, it, expect } from 'vitest';
import { normalizeRepo } from './repo-format';

describe('normalizeRepo', () => {
  it('returns the lowercased owner/name for valid lowercase input', () => {
    expect(normalizeRepo('mthines/lorekit')).toBe('mthines/lorekit');
  });

  it('lowercases valid uppercase or mixed-case input', () => {
    expect(normalizeRepo('Mthines/LoreKit')).toBe('mthines/lorekit');
    expect(normalizeRepo('ACME-ORG/Service')).toBe('acme-org/service');
  });

  it('trims surrounding whitespace before validating', () => {
    expect(normalizeRepo('  mthines/lorekit  ')).toBe('mthines/lorekit');
  });

  it('accepts dots, underscores, and dashes in either segment', () => {
    expect(normalizeRepo('my-org.io/my_repo.name')).toBe('my-org.io/my_repo.name');
  });

  it('returns null for empty input', () => {
    expect(normalizeRepo('')).toBeNull();
    expect(normalizeRepo('   ')).toBeNull();
  });

  it('returns null when the slash is missing', () => {
    expect(normalizeRepo('mthineslorekit')).toBeNull();
  });

  it('returns null when there are extra segments (more than one slash)', () => {
    expect(normalizeRepo('mthines/lorekit/extra')).toBeNull();
  });

  it('returns null when a segment contains internal whitespace', () => {
    expect(normalizeRepo('mthines/lore kit')).toBeNull();
  });

  it('returns null when a segment is empty (leading or trailing slash)', () => {
    expect(normalizeRepo('/lorekit')).toBeNull();
    expect(normalizeRepo('mthines/')).toBeNull();
  });
});
