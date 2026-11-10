import { describe, it, expect } from 'vitest';
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_METADATA_KEY,
  editableDisplayName,
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

  it('writes to a key GitHub sign-in never sends, so a GitHub login cannot overwrite it', () => {
    // GitHub identity data carries `full_name` and `name`; GoTrue merges it into
    // user_metadata on every sign-in. The chosen name must live elsewhere.
    expect(DISPLAY_NAME_METADATA_KEY).not.toBe('full_name');
    expect(DISPLAY_NAME_METADATA_KEY).not.toBe('name');
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

describe('editableDisplayName', () => {
  it('starts the field from display_name, then full_name', () => {
    expect(editableDisplayName({ user_metadata: { display_name: 'Jane', full_name: 'Jane Doe' } })).toBe('Jane');
    expect(editableDisplayName({ user_metadata: { full_name: 'Jane Doe' } })).toBe('Jane Doe');
  });

  it('never prefills the email address as a name', () => {
    expect(editableDisplayName({ email: 'jane@example.com', user_metadata: {} })).toBe('');
    expect(editableDisplayName({ email: 'jane@example.com' })).toBe('');
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
