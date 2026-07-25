import { describe, it, expect } from 'vitest';
import { permissionSuffix, tierFor, PERMISSION_TIERS } from './token-permission';

describe('permissionSuffix', () => {
  it('returns "rw" for read+write', () => {
    expect(permissionSuffix(['read', 'write'])).toBe('rw');
  });

  it('returns "ro" for read only', () => {
    expect(permissionSuffix(['read'])).toBe('ro');
  });

  it('returns "wo" for write only', () => {
    expect(permissionSuffix(['write'])).toBe('wo');
  });

  it('throws on an empty permission set', () => {
    expect(() => permissionSuffix([])).toThrow();
  });
});

describe('tierFor', () => {
  it('resolves the write-only tier badge label', () => {
    expect(tierFor(['write'])).toBe('wo');
    const tier = PERMISSION_TIERS.find((t) => t.value === tierFor(['write']));
    expect(tier?.badgeLabel).toBe('write-only');
  });

  it('resolves the read-only and read+write tier badge labels', () => {
    expect(PERMISSION_TIERS.find((t) => t.value === tierFor(['read']))?.badgeLabel).toBe('read-only');
    expect(PERMISSION_TIERS.find((t) => t.value === tierFor(['read', 'write']))?.badgeLabel).toBe('read+write');
  });
});

describe('PERMISSION_TIERS', () => {
  it('has exactly the three tiers with distinct values', () => {
    expect(PERMISSION_TIERS.map((t) => t.value).sort()).toEqual(['ro', 'rw', 'wo']);
  });

  it('write-only tier describes "Agent can write but not read"', () => {
    const wo = PERMISSION_TIERS.find((t) => t.value === 'wo');
    expect(wo?.label).toBe('Write only');
    expect(wo?.desc).toBe('Agent can write but not read');
    expect(wo?.perms).toEqual(['write']);
  });
});
