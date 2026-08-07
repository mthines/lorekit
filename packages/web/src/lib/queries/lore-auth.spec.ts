/**
 * The signed-out read policy for the Lore Explorer's client queries.
 *
 * These hooks reject rather than resolving empty, because an empty account and
 * a lapsed session render identically. That only works if the rest of the app
 * can tell the two errors apart and does not retry the one that cannot
 * succeed — the two decisions pinned here.
 */

import { describe, it, expect } from 'vitest';
import { RestApiError } from '@/lib/api/rest';
import {
  NotAuthenticatedError,
  isNotAuthenticated,
  isUnretryableRequest,
  retryMemoryById,
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

describe('isUnretryableRequest', () => {
  it('recognises the two answers a bad or unresolvable memoryId gets', () => {
    expect(isUnretryableRequest(new RestApiError(404, 'Not found'))).toBe(true);
    expect(isUnretryableRequest(new RestApiError(400, 'Invalid uuid'))).toBe(true);
  });

  it('leaves anything that might succeed on a second attempt alone', () => {
    expect(isUnretryableRequest(new RestApiError(500, 'Boom'))).toBe(false);
    expect(isUnretryableRequest(new RestApiError(429, 'Slow down'))).toBe(false);
    expect(isUnretryableRequest(new RestApiError(401, 'Unauthorized'))).toBe(false);
    expect(isUnretryableRequest(new Error('fetch failed'))).toBe(false);
    expect(isUnretryableRequest({ status: 404 })).toBe(false);
  });
});

describe('retryMemoryById', () => {
  it('never retries a 404 — an archived or unknown id answers the same every time', () => {
    expect(retryMemoryById(0, new RestApiError(404, 'Not found'))).toBe(false);
  });

  it('never retries a 400 — the id is not a UUID and will not become one', () => {
    expect(retryMemoryById(0, new RestApiError(400, 'Invalid uuid'))).toBe(false);
  });

  it('still never retries a signed-out read', () => {
    expect(retryMemoryById(0, new NotAuthenticatedError())).toBe(false);
  });

  it('keeps the default budget for a failure that might be transient', () => {
    const transient = new RestApiError(503, 'Service unavailable');
    expect(retryMemoryById(0, transient)).toBe(true);
    expect(retryMemoryById(2, transient)).toBe(true);
    expect(retryMemoryById(3, transient)).toBe(false);
  });
});
