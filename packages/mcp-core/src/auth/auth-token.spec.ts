import { describe, it, expect } from 'vitest';
import { extractToken } from './auth-token.js';

describe('extractToken', () => {
  // ── Authorization header (preferred path) ──────────────────────────────────

  it('extracts a token from a well-formed Authorization: Bearer header', () => {
    expect(extractToken('Bearer lk_rw_abc123', null)).toBe('lk_rw_abc123');
  });

  it('extracts a token when the header value has trailing whitespace', () => {
    expect(extractToken('Bearer lk_rw_abc123  ', null)).toBe('lk_rw_abc123');
  });

  it('returns null for an Authorization header that is not Bearer', () => {
    expect(extractToken('Basic dXNlcjpwYXNz', null)).toBeNull();
  });

  it('returns null for a Bearer header with an empty token', () => {
    expect(extractToken('Bearer ', null)).toBeNull();
    expect(extractToken('Bearer   ', null)).toBeNull();
  });

  // ── Query-string fallback ──────────────────────────────────────────────────

  it('extracts a token from the query parameter when no Authorization header is present', () => {
    expect(extractToken(null, 'lk_rw_abc123')).toBe('lk_rw_abc123');
  });

  it('extracts a token from the query parameter when Authorization header is absent (undefined)', () => {
    expect(extractToken(undefined, 'lk_rw_abc123')).toBe('lk_rw_abc123');
  });

  it('trims whitespace from the query parameter token', () => {
    expect(extractToken(null, '  lk_rw_abc123  ')).toBe('lk_rw_abc123');
  });

  // ── Header takes precedence over query param ───────────────────────────────

  it('prefers the Authorization header over the query parameter when both are present', () => {
    expect(extractToken('Bearer lk_rw_header', 'lk_rw_queryparam')).toBe('lk_rw_header');
  });

  it('falls through to the query parameter when the Authorization header is not Bearer', () => {
    expect(extractToken('Basic dXNlcjpwYXNz', 'lk_rw_queryparam')).toBe('lk_rw_queryparam');
  });

  it('falls through to the query parameter when the Bearer token is empty', () => {
    expect(extractToken('Bearer ', 'lk_rw_queryparam')).toBe('lk_rw_queryparam');
  });

  // ── Both absent ────────────────────────────────────────────────────────────

  it('returns null when both header and query param are null', () => {
    expect(extractToken(null, null)).toBeNull();
  });

  it('returns null when both header and query param are undefined', () => {
    expect(extractToken(undefined, undefined)).toBeNull();
  });

  it('returns null when both header and query param are empty strings', () => {
    expect(extractToken('', '')).toBeNull();
  });
});
