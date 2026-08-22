import { describe, it, expect } from 'vitest';
import {
  translateOrgPermissionError,
  OrgPermissionError,
  UnknownOrgError,
  ORG_PERMISSION_SQLSTATE,
} from './org-permissions.js';

describe('translateOrgPermissionError', () => {
  it('translates an LK002 error into an actionable OrgPermissionError', () => {
    const dbError = { code: ORG_PERMISSION_SQLSTATE, message: 'org_permission_denied: org=acme capability=write' };
    const result = translateOrgPermissionError(dbError);
    expect(result).toBeInstanceOf(OrgPermissionError);
    const orgError = result as OrgPermissionError;
    expect(orgError.code).toBe('org_permission_denied');
    expect(orgError.message).toContain('acme');
    expect(orgError.message.toLowerCase()).toMatch(/permission|role/);
  });

  it('passes unrelated errors through unchanged', () => {
    const dbError = { code: 'LK001', message: 'memory_cap_exceeded: limit=1000' };
    const result = translateOrgPermissionError(dbError);
    expect(result).toBe(dbError);
  });

  it('passes through errors with no code at all', () => {
    const dbError = new Error('network timeout');
    const result = translateOrgPermissionError(dbError);
    expect(result).toBe(dbError);
  });

  it('falls back to a generic message when the DB error has no message', () => {
    const dbError = { code: ORG_PERMISSION_SQLSTATE };
    const result = translateOrgPermissionError(dbError) as OrgPermissionError;
    expect(result).toBeInstanceOf(OrgPermissionError);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('translates an unknown_org message into a client-caused UnknownOrgError', () => {
    // Raised by every org-resolving RPC (memory_write, memory_delete, the
    // memory_ttl family, ...) via `raise exception using errcode = 'P0001',
    // message = format('unknown_org: %s', p_org_slug)` — a caller-supplied
    // org slug that does not resolve, not a server-side fault.
    const dbError = { code: 'P0001', message: 'unknown_org: acme-nonexistent' };
    const result = translateOrgPermissionError(dbError);
    expect(result).toBeInstanceOf(UnknownOrgError);
    const orgError = result as UnknownOrgError;
    expect(orgError.code).toBe('unknown_org');
    expect(orgError.message).toBe('unknown_org: acme-nonexistent');
  });

  it('does not misclassify an unrelated P0001 error as UnknownOrgError', () => {
    const dbError = { code: 'P0001', message: 'some other raised exception' };
    const result = translateOrgPermissionError(dbError);
    expect(result).toBe(dbError);
  });
});
