import { describe, it, expect } from 'vitest';
import { normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('strips the plus subaddress', () => {
    expect(normalizeEmail('user+alias@example.com')).toBe('user@example.com');
  });

  it('strips the plus subaddress from a real-world address', () => {
    expect(normalizeEmail('madsthines+1@gmail.com')).toBe('madsthines@gmail.com');
  });

  it('strips multiple plus segments (only up to the first plus)', () => {
    expect(normalizeEmail('user+tag+extra@x.io')).toBe('user@x.io');
  });

  it('lowercases the address', () => {
    expect(normalizeEmail('User@Example.COM')).toBe('user@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('returns the address unchanged when there is no plus', () => {
    expect(normalizeEmail('user@example.com')).toBe('user@example.com');
  });

  it('handles a plus in the domain gracefully (strips from local only)', () => {
    // Domains with + are invalid but we should not crash
    expect(normalizeEmail('user@exam+ple.com')).toBe('user@exam+ple.com');
  });

  it('handles an address with no @ (invalid — returns trimmed lowercase)', () => {
    expect(normalizeEmail('notanemail')).toBe('notanemail');
  });

  it('uses the last @ as the local/domain boundary', () => {
    // An address with multiple @ chars is invalid, but we should not crash.
    // lastIndexOf('@') splits it as local='user+alias@sub', domain='domain.com',
    // then the plus-strip yields 'user@domain.com'.
    expect(normalizeEmail('user+alias@sub@domain.com')).toBe('user@domain.com');
  });
});
