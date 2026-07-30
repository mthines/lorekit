import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  validatePassword,
  validatePasswordConfirmation,
} from './password-policy';

describe('validatePassword', () => {
  it('accepts a password at or above the minimum length', () => {
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(validatePassword('correct horse battery staple')).toBeNull();
  });

  it('rejects an empty password with a distinct message', () => {
    expect(validatePassword('')).toBe('Please enter a password.');
  });

  it('rejects a password shorter than the minimum length', () => {
    const error = validatePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1));
    expect(error).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  });

  it('rejects a whitespace-only password that is long enough', () => {
    expect(validatePassword(' '.repeat(MIN_PASSWORD_LENGTH))).toBe(
      'Password cannot be only spaces.',
    );
  });

  it('does not trim — leading/trailing spaces are part of the password', () => {
    expect(validatePassword(` ${'a'.repeat(MIN_PASSWORD_LENGTH)} `)).toBeNull();
  });
});

describe('validatePasswordConfirmation', () => {
  it('accepts a valid, matching pair', () => {
    expect(validatePasswordConfirmation('hunter2hunter2', 'hunter2hunter2')).toBeNull();
  });

  it('reports the policy error before the mismatch error', () => {
    expect(validatePasswordConfirmation('short', 'different')).toBe(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  });

  it('reports a mismatch when both halves satisfy the policy', () => {
    expect(validatePasswordConfirmation('hunter2hunter2', 'hunter2hunter3')).toBe(
      'The two passwords do not match.',
    );
  });

  it('treats a case difference as a mismatch', () => {
    expect(validatePasswordConfirmation('hunter2hunter2', 'Hunter2hunter2')).toBe(
      'The two passwords do not match.',
    );
  });
});
