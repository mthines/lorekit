import { describe, expect, it } from 'vitest';

import { classifyAuthOutcome, NEW_ACCOUNT_TOLERANCE_MS } from './auth-outcome';

const CREATED = '2026-08-04T10:00:00.000Z';
/** `CREATED` shifted by `ms`, as an ISO string. */
const offset = (ms: number) => new Date(Date.parse(CREATED) + ms).toISOString();

describe('classifyAuthOutcome', () => {
  it('reports a signup when the first sign-in is the account creation', () => {
    expect(classifyAuthOutcome({ createdAt: CREATED, lastSignInAt: CREATED })).toBe(
      'account_created',
    );
  });

  it('tolerates the write skew between the insert and the sign-in stamp', () => {
    expect(classifyAuthOutcome({ createdAt: CREATED, lastSignInAt: offset(250) })).toBe(
      'account_created',
    );
  });

  it('reports a returning sign-in once the account predates it', () => {
    const aWeek = 7 * 24 * 60 * 60 * 1000;
    expect(classifyAuthOutcome({ createdAt: CREATED, lastSignInAt: offset(aWeek) })).toBe(
      'returning_sign_in',
    );
  });

  // The boundary is what separates the two populations, so pin both sides.
  it('treats the tolerance as inclusive and anything past it as returning', () => {
    expect(
      classifyAuthOutcome({ createdAt: CREATED, lastSignInAt: offset(NEW_ACCOUNT_TOLERANCE_MS) }),
    ).toBe('account_created');
    expect(
      classifyAuthOutcome({
        createdAt: CREATED,
        lastSignInAt: offset(NEW_ACCOUNT_TOLERANCE_MS + 1),
      }),
    ).toBe('returning_sign_in');
  });

  // `unknown` must stay its own bucket: folding it into either side would bias
  // the signup count by exactly the cases the data is least sure about.
  it('reports unknown when either timestamp is absent', () => {
    expect(classifyAuthOutcome({ createdAt: CREATED, lastSignInAt: null })).toBe('unknown');
    expect(classifyAuthOutcome({ createdAt: undefined, lastSignInAt: CREATED })).toBe('unknown');
    expect(classifyAuthOutcome({})).toBe('unknown');
  });

  it('reports unknown for an unparseable timestamp', () => {
    expect(classifyAuthOutcome({ createdAt: 'not-a-date', lastSignInAt: CREATED })).toBe('unknown');
  });

  it('reports unknown rather than a signup when sign-in precedes creation', () => {
    expect(classifyAuthOutcome({ createdAt: CREATED, lastSignInAt: offset(-5000) })).toBe(
      'unknown',
    );
  });
});
