import { describe, it, expect } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  chosenDisplayName,
  fallbackDisplayName,
  resolveDisplayName,
  validateDisplayName,
} from './display-name';

describe('resolveDisplayName', () => {
  it('prefers the chosen display_name over the GitHub full_name', () => {
    expect(
      resolveDisplayName({
        email: 'jane@example.com',
        user_metadata: { display_name: 'Jane', full_name: 'Jane Doe' },
      }),
    ).toBe('Jane');
  });

  it('falls back when a chosen name was cleared to null', () => {
    // GoTrue deletes a key set to null on an existing metadata object, but
    // stores the update verbatim when user_metadata was empty — so a literal
    // null can reach the reader.
    expect(
      resolveDisplayName({ email: 'jane@example.com', user_metadata: { display_name: null, full_name: 'Jane Doe' } }),
    ).toBe('Jane Doe');
  });

  it('falls back to full_name, then email, then "User"', () => {
    expect(resolveDisplayName({ email: 'jane@example.com', user_metadata: { full_name: 'Jane Doe' } })).toBe(
      'Jane Doe',
    );
    expect(resolveDisplayName({ email: 'jane@example.com', user_metadata: {} })).toBe('jane@example.com');
    expect(resolveDisplayName({})).toBe('User');
  });

  it('skips blank and non-string values', () => {
    expect(
      resolveDisplayName({
        email: 'jane@example.com',
        user_metadata: { display_name: '   ', full_name: 42 },
      }),
    ).toBe('jane@example.com');
  });

  it('trims the shown name', () => {
    expect(resolveDisplayName({ user_metadata: { display_name: '  Jane  ' } })).toBe('Jane');
  });
});

describe('chosenDisplayName', () => {
  it('holds only the name the user chose, never the GitHub name', () => {
    expect(chosenDisplayName({ user_metadata: { display_name: ' Jane ', full_name: 'Jane Doe' } })).toBe('Jane');
    // An empty field must mean "use the default", so the default is not prefilled.
    expect(chosenDisplayName({ user_metadata: { full_name: 'Jane Doe' } })).toBe('');
    expect(chosenDisplayName({ email: 'jane@example.com' })).toBe('');
  });
});

describe('fallbackDisplayName', () => {
  it('ignores the chosen name and returns full_name, then email, then "User"', () => {
    expect(fallbackDisplayName({ user_metadata: { display_name: 'Jane', full_name: 'Jane Doe' } })).toBe('Jane Doe');
    expect(fallbackDisplayName({ email: 'jane@example.com', user_metadata: {} })).toBe('jane@example.com');
    expect(fallbackDisplayName({})).toBe('User');
  });
});

describe('validateDisplayName', () => {
  it('returns the trimmed name', () => {
    expect(validateDisplayName('  Jane Doe ')).toEqual({ ok: true, value: 'Jane Doe' });
  });

  it('treats an empty field as "clear my name", not an error', () => {
    expect(validateDisplayName('')).toEqual({ ok: true, value: null });
    expect(validateDisplayName('   ')).toEqual({ ok: true, value: null });
  });

  it('accepts exactly the maximum length, counting characters rather than UTF-16 units', () => {
    expect(validateDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
    // Each emoji is two UTF-16 code units but one character.
    expect(validateDisplayName('😀'.repeat(DISPLAY_NAME_MAX_LENGTH)).ok).toBe(true);
  });

  it('rejects a name over the maximum length', () => {
    const result = validateDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(DISPLAY_NAME_MAX_LENGTH));
  });

  it('rejects line breaks and tabs inside the name', () => {
    expect(validateDisplayName('Jane\nDoe').ok).toBe(false);
    expect(validateDisplayName('Jane\tDoe').ok).toBe(false);
  });

  it('accepts non-Latin names', () => {
    expect(validateDisplayName('Søren Ægir')).toEqual({ ok: true, value: 'Søren Ægir' });
    expect(validateDisplayName('山田太郎')).toEqual({ ok: true, value: '山田太郎' });
  });
});
