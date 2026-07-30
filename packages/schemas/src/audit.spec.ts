import { describe, it, expect } from 'vitest';
import {
  AUDIT_ACTIONS,
  AuditActionSchema,
  AuditEntryInputSchema,
  AuditRowSchema,
} from './audit.ts';

describe('AUDIT_ACTIONS', () => {
  it('has no duplicate entries', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  // Anti-vacuity for every list-shaped assertion below: if the tuple were ever
  // emptied or truncated, `it.each` would silently run zero cases and pass.
  it('is the full 24-action vocabulary', () => {
    expect(AUDIT_ACTIONS.length).toBe(24);
  });

  it('includes github_app.installation_linked — the action the CHECK constraint used to reject', () => {
    expect(AUDIT_ACTIONS).toContain('github_app.installation_linked');
  });
});

describe('AuditActionSchema', () => {
  it.each(AUDIT_ACTIONS)('accepts the valid action %s', (action) => {
    expect(AuditActionSchema.parse(action)).toBe(action);
  });

  it.each([
    'memory.destroy',
    'org.purge',
    'API_KEY.CREATE',
    'memory.create ',
    '',
  ])('rejects the unknown action %j', (action) => {
    expect(AuditActionSchema.safeParse(action).success).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(AuditActionSchema.safeParse(42).success).toBe(false);
    expect(AuditActionSchema.safeParse(null).success).toBe(false);
  });
});

describe('AuditEntryInputSchema', () => {
  it('accepts an action-only input — every other field is optional', () => {
    const parsed = AuditEntryInputSchema.parse({ action: 'memory.create' });
    expect(parsed).toEqual({ action: 'memory.create' });
  });

  it('accepts explicit nulls as well as omissions (nullish, matching the writers)', () => {
    const parsed = AuditEntryInputSchema.parse({
      action: 'memory.delete',
      resourceType: null,
      resourceId: null,
      target: null,
      metadata: null,
    });
    expect(parsed.resourceType).toBeNull();
    expect(parsed.metadata).toBeNull();
  });

  it('accepts a fully-populated input', () => {
    const parsed = AuditEntryInputSchema.parse({
      action: 'api_key.create',
      resourceType: 'api_token',
      resourceId: 'token-1',
      target: 'ci-runner',
      metadata: { token_prefix: 'lk_rw_aBcD1...' },
    });
    expect(parsed.target).toBe('ci-runner');
    expect(parsed.metadata).toEqual({ token_prefix: 'lk_rw_aBcD1...' });
  });

  it('rejects an input whose action is not in the vocabulary', () => {
    expect(AuditEntryInputSchema.safeParse({ action: 'memory.obliterate' }).success).toBe(false);
  });

  it('rejects an input with no action at all', () => {
    expect(AuditEntryInputSchema.safeParse({ target: 'x' }).success).toBe(false);
  });
});

describe('AuditRowSchema', () => {
  it('accepts a row with every non-action field null', () => {
    const row = {
      action: 'memory.archive',
      resource_type: null,
      resource_id: null,
      target: null,
      metadata: null,
    };
    expect(AuditRowSchema.parse(row)).toEqual(row);
  });

  it('accepts a fully-populated row', () => {
    const row = {
      action: 'member.role_change',
      resource_type: 'org_member',
      resource_id: '2f1c1e5e-0000-4000-8000-000000000000',
      target: 'acme',
      metadata: { role: 'admin' },
    };
    expect(AuditRowSchema.parse(row)).toEqual(row);
  });

  // Nullable, NOT nullish: the row is the writer's OUTPUT, and buildAuditEntry
  // always normalises an absent field to an explicit null. A row with a field
  // simply missing means the writer skipped that normalisation.
  it.each(['resource_type', 'resource_id', 'target', 'metadata'])(
    'requires %s to be present (nullable, not optional)',
    (field) => {
      const row: Record<string, unknown> = {
        action: 'memory.restore',
        resource_type: null,
        resource_id: null,
        target: null,
        metadata: null,
      };
      delete row[field];
      expect(AuditRowSchema.safeParse(row).success).toBe(false);
    },
  );

  it('rejects a row whose action is not in the vocabulary', () => {
    expect(
      AuditRowSchema.safeParse({
        action: 'memory.nuke',
        resource_type: null,
        resource_id: null,
        target: null,
        metadata: null,
      }).success,
    ).toBe(false);
  });
});
