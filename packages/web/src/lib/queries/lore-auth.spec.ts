/**
 * The signed-out read policy for the Lore Explorer's client queries.
 *
 * These hooks reject rather than resolving empty, because an empty account and
 * a lapsed session render identically. That only works if the rest of the app
 * can tell the two errors apart and does not retry the one that cannot
 * succeed — the two decisions pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  NotAuthenticatedError,
  isNotAuthenticated,
  retryUnlessSignedOut,
} from './lore';

describe('isNotAuthenticated', () => {
  it('recognises the signed-out error', () => {
    expect(isNotAuthenticated(new NotAuthenticatedError())).toBe(true);
  });

  it('does not claim any other failure is a session problem', () => {
    expect(isNotAuthenticated(new Error('Network request failed'))).toBe(false);
    expect(isNotAuthenticated({ name: 'NotAuthenticatedError' })).toBe(false);
    expect(isNotAuthenticated(undefined)).toBe(false);
    expect(isNotAuthenticated(null)).toBe(false);
  });
});

describe('retryUnlessSignedOut', () => {
  it('never retries a signed-out read — three more round trips cannot fix it', () => {
    expect(retryUnlessSignedOut(0, new NotAuthenticatedError())).toBe(false);
  });

  it('keeps the default retry budget for a failure that might be transient', () => {
    const transient = new Error('fetch failed');
    expect(retryUnlessSignedOut(0, transient)).toBe(true);
    expect(retryUnlessSignedOut(2, transient)).toBe(true);
    expect(retryUnlessSignedOut(3, transient)).toBe(false);
  });
});
