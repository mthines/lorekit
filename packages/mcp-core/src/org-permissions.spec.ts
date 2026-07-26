import { describe, it, expect } from 'vitest';
import { translateOrgPermissionError, OrgPermissionError, ORG_PERMISSION_SQLSTATE } from './org-permissions.js';

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
});
