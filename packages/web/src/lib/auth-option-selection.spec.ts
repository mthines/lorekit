import { describe, it, expect } from 'vitest';
import { markOptionSelected } from './auth-option-selection';
import type { AuthMethod } from './auth-telemetry';

describe('markOptionSelected', () => {
  it('reports the first selection of a method', () => {
    const selected = new Set<AuthMethod>();
    expect(markOptionSelected(selected, 'github_oauth')).toBe(true);
  });

  it('records the method so the caller does not have to', () => {
    const selected = new Set<AuthMethod>();
    markOptionSelected(selected, 'github_oauth');
    expect(selected.has('github_oauth')).toBe(true);
  });

  it('does not report a repeat selection of the same method', () => {
    const selected = new Set<AuthMethod>();
    markOptionSelected(selected, 'email_password');
    expect(markOptionSelected(selected, 'email_password')).toBe(false);
  });

  it('reports each distinct method once', () => {
    const selected = new Set<AuthMethod>();
    const reported = (['github_oauth', 'email_password', 'email_otp'] as const).filter((method) =>
      markOptionSelected(selected, method),
    );
    expect(reported).toEqual(['github_oauth', 'email_password', 'email_otp']);
  });

  it('reports a toggled-back-and-forth pair exactly twice, not once per switch', () => {
    // The login panel's "Create an account" / "I already have an account" pair,
    // pressed four times. Two routes were shown interest in, so two events.
    const selected = new Set<AuthMethod>();
    const switches: AuthMethod[] = [
      'email_password_signup',
      'email_password',
      'email_password_signup',
      'email_password',
    ];
    const reported = switches.filter((method) => markOptionSelected(selected, method));
    expect(reported).toEqual(['email_password_signup', 'email_password']);
  });

  it('counts the same route reached through a different control only once', () => {
    // "Continue with email" from the landing state and "Use a password instead"
    // from the magic-link panel are the same route — the count must not depend
    // on which door the visitor came through.
    const selected = new Set<AuthMethod>();
    expect(markOptionSelected(selected, 'email_password')).toBe(true);
    expect(markOptionSelected(selected, 'email_password')).toBe(false);
  });

  it('treats a separate set as a separate document', () => {
    const firstDocument = new Set<AuthMethod>();
    const secondDocument = new Set<AuthMethod>();
    markOptionSelected(firstDocument, 'email_otp');
    expect(markOptionSelected(secondDocument, 'email_otp')).toBe(true);
  });

  it('leaves an unrelated method unrecorded', () => {
    const selected = new Set<AuthMethod>();
    markOptionSelected(selected, 'email_otp');
    expect(selected.has('email_password')).toBe(false);
  });
});
