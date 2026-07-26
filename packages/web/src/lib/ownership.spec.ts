import { describe, it, expect } from 'vitest';
import { ownerFromMemoryRow } from './ownership';

describe('ownerFromMemoryRow', () => {
  it('maps an embedded org to {id, name} when org_id is set and the join resolved', () => {
    expect(
      ownerFromMemoryRow({ org_id: 'org-1', org: { id: 'org-1', name: 'Acme Team' } }),
    ).toEqual({ id: 'org-1', name: 'Acme Team' });
  });

  it('returns undefined when org_id is null (personal memory)', () => {
    expect(ownerFromMemoryRow({ org_id: null, org: null })).toBeUndefined();
  });

  it('returns undefined when org_id is undefined (field omitted entirely)', () => {
    expect(ownerFromMemoryRow({})).toBeUndefined();
  });

  it('returns undefined when org_id is set but the embedded org failed to resolve', () => {
    // Defensive fallback for the PostgREST-embed-fails risk noted in plan.md —
    // never fabricate a placeholder org name for a half-populated row.
    expect(ownerFromMemoryRow({ org_id: 'org-1', org: null })).toBeUndefined();
  });
});
