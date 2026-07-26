import { describe, it, expect } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { resolveAuditActor } from './audit-actor';

function buildUser(metadata: Record<string, unknown>, email: string | null = 'jane@example.com'): User {
  return {
    id: 'user-1',
    app_metadata: {},
    user_metadata: metadata,
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
    email: email ?? undefined,
  } as User;
}

describe('resolveAuditActor', () => {
  it('returns a user actor with full_name and avatar_url when both are present', () => {
    const user = buildUser({ full_name: 'Jane Doe', avatar_url: 'https://example.com/jane.png' });
    expect(resolveAuditActor(user)).toEqual({
      kind: 'user',
      name: 'Jane Doe',
      avatarUrl: 'https://example.com/jane.png',
    });
  });

  it('falls back to email when full_name is absent', () => {
    const user = buildUser({}, 'jane@example.com');
    expect(resolveAuditActor(user)).toEqual({
      kind: 'user',
      name: 'jane@example.com',
      avatarUrl: null,
    });
  });

  it('falls back to email when full_name is blank/whitespace', () => {
    const user = buildUser({ full_name: '   ' }, 'jane@example.com');
    expect(resolveAuditActor(user)).toEqual({
      kind: 'user',
      name: 'jane@example.com',
      avatarUrl: null,
    });
  });

  it('returns avatarUrl: null when avatar_url is absent', () => {
    const user = buildUser({ full_name: 'Jane Doe' });
    expect(resolveAuditActor(user)).toEqual({
      kind: 'user',
      name: 'Jane Doe',
      avatarUrl: null,
    });
  });

  it('returns the neutral system actor when the user is null', () => {
    expect(resolveAuditActor(null)).toEqual({ kind: 'system', name: 'System' });
  });

  it('falls back to the literal "User" when both full_name and email are absent', () => {
    const user = buildUser({}, null);
    expect(resolveAuditActor(user)).toEqual({
      kind: 'user',
      name: 'User',
      avatarUrl: null,
    });
  });
});
