import { describe, it, expect } from 'vitest';
import { READ_TOOLS, WRITE_TOOLS, toolRequires, tokenPrefixFor } from './permissions.js';

describe('tokenPrefixFor', () => {
  it('returns "rw" for read+write', () => {
    expect(tokenPrefixFor(['read', 'write'])).toBe('rw');
  });

  it('returns "ro" for read only', () => {
    expect(tokenPrefixFor(['read'])).toBe('ro');
  });

  it('returns "wo" for write only', () => {
    expect(tokenPrefixFor(['write'])).toBe('wo');
  });

  it('throws on an empty permission set', () => {
    expect(() => tokenPrefixFor([])).toThrow();
  });
});

describe('toolRequires', () => {
  it('maps write tools to "write"', () => {
    expect(toolRequires('memory.write')).toBe('write');
    expect(toolRequires('memory.delete')).toBe('write');
    expect(toolRequires('memory.archive')).toBe('write');
    expect(toolRequires('memory.restore')).toBe('write');
    expect(toolRequires('memory.purge')).toBe('write');
  });

  it('maps read tools to "read"', () => {
    expect(toolRequires('memory.read')).toBe('read');
    expect(toolRequires('memory.list')).toBe('read');
    expect(toolRequires('memory.search')).toBe('read');
    expect(toolRequires('memory.list_archived')).toBe('read');
  });

  it('returns null for an unknown tool name', () => {
    expect(toolRequires('memory.unknown')).toBeNull();
  });
});

describe('READ_TOOLS / WRITE_TOOLS', () => {
  it('are disjoint sets', () => {
    for (const tool of READ_TOOLS) {
      expect(WRITE_TOOLS.has(tool)).toBe(false);
    }
  });

  it('cover the documented tool families', () => {
    expect([...READ_TOOLS].sort()).toEqual(
      // `memory.scopes` is the inventory read: the one read tool that takes no
      // scope. It is gated with the family because scope STRINGS embed repo and
      // project names — it is not exempt merely because it names no scope.
      // `org.list` joined the read family when the org tools stopped being
      // JWT-only: listing the orgs you belong to is exactly what a read token
      // should be able to do.
      ['memory.list', 'memory.list_archived', 'memory.read', 'memory.scopes', 'memory.search', 'org.list'].sort(),
    );
    expect([...WRITE_TOOLS].sort()).toEqual(
      // The org mutations likewise. Token permission is orthogonal to org ROLE
      // and does not replace it — a `lk_rw_*` held by a viewer still cannot
      // rename, because `lorekit_org_can` is still the only role gate.
      [
        'memory.archive', 'memory.delete', 'memory.purge', 'memory.purge_expired',
        'memory.restore', 'memory.write',
        'org.create', 'org.delete', 'org.rename',
      ].sort(),
    );
  });
});
