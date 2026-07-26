import { describe, it, expect } from 'vitest';
import {
  mapInstallationEvent,
  reconcileInstallation,
  buildInstallationTokenClaims,
  type InstallationOp,
} from './webhook-installation.js';

describe('mapInstallationEvent', () => {
  it('installation.created → upsert_installation', () => {
    const op = mapInstallationEvent('installation', 'created');
    expect(op.kind).toBe('upsert_installation');
  });

  it('installation.unsuspend → upsert_installation', () => {
    const op = mapInstallationEvent('installation', 'unsuspend');
    expect(op.kind).toBe('upsert_installation');
  });

  it('installation.new_permissions_accepted → upsert_installation', () => {
    const op = mapInstallationEvent('installation', 'new_permissions_accepted');
    expect(op.kind).toBe('upsert_installation');
  });

  it('installation.deleted → remove_installation', () => {
    const op = mapInstallationEvent('installation', 'deleted');
    expect(op.kind).toBe('remove_installation');
  });

  it('installation.suspend → remove_installation', () => {
    const op = mapInstallationEvent('installation', 'suspend');
    expect(op.kind).toBe('remove_installation');
  });

  it('installation.unknown_action → ignore', () => {
    const op = mapInstallationEvent('installation', 'frobnicate');
    expect(op.kind).toBe('ignore');
    if (op.kind === 'ignore') expect(op.reason).toContain('installation.frobnicate');
  });

  it('installation_repositories.added → add_repos', () => {
    const op = mapInstallationEvent('installation_repositories', 'added');
    expect(op.kind).toBe('add_repos');
  });

  it('installation_repositories.removed → remove_repos', () => {
    const op = mapInstallationEvent('installation_repositories', 'removed');
    expect(op.kind).toBe('remove_repos');
  });

  it('installation_repositories.unknown_action → ignore', () => {
    const op = mapInstallationEvent('installation_repositories', 'frobnicate');
    expect(op.kind).toBe('ignore');
  });

  it('installation_target → ignore', () => {
    const op = mapInstallationEvent('installation_target', 'renamed');
    expect(op.kind).toBe('ignore');
  });

  it('github_app_authorization → ignore', () => {
    const op = mapInstallationEvent('github_app_authorization', 'revoked');
    expect(op.kind).toBe('ignore');
  });

  it('membership → ignore', () => {
    const op = mapInstallationEvent('membership', 'added');
    expect(op.kind).toBe('ignore');
  });

  it('completely unknown event → ignore', () => {
    const op = mapInstallationEvent('push', 'created');
    expect(op.kind).toBe('ignore');
    if (op.kind === 'ignore') expect(op.reason).toContain('push.created');
  });

  it('the upsert_installation op carries an empty repos array by default', () => {
    const op = mapInstallationEvent('installation', 'created') as Extract<InstallationOp, { kind: 'upsert_installation' }>;
    expect(op.repos).toEqual([]);
  });

  it('the add_repos op carries an empty repos array by default', () => {
    const op = mapInstallationEvent('installation_repositories', 'added') as Extract<InstallationOp, { kind: 'add_repos' }>;
    expect(op.repos).toEqual([]);
  });
});

describe('reconcileInstallation', () => {
  it('returns pending when no matching user exists (null knownUser)', () => {
    const verdict = reconcileInstallation(12345, null);
    expect(verdict.kind).toBe('pending');
    if (verdict.kind === 'pending') {
      expect(verdict.githubAccountId).toBe(12345);
    }
  });

  it('returns linked when a matching user is found', () => {
    const verdict = reconcileInstallation(12345, { userId: 'user-uuid-abc' });
    expect(verdict.kind).toBe('linked');
    if (verdict.kind === 'linked') {
      expect(verdict.userId).toBe('user-uuid-abc');
    }
  });

  it('pending verdict preserves the GitHub account id for future reconcile', () => {
    const verdict = reconcileInstallation(99999, null);
    if (verdict.kind !== 'pending') throw new Error('expected pending');
    expect(verdict.githubAccountId).toBe(99999);
  });

  it('linked verdict carries the resolved LoreKit user uuid', () => {
    const verdict = reconcileInstallation(42, { userId: 'the-lorekit-user-id' });
    if (verdict.kind !== 'linked') throw new Error('expected linked');
    expect(verdict.userId).toBe('the-lorekit-user-id');
  });

  it('always returns a discriminated union — never undefined or null', () => {
    expect(reconcileInstallation(1, null)).toBeDefined();
    expect(reconcileInstallation(1, { userId: 'u' })).toBeDefined();
  });
});

describe('buildInstallationTokenClaims', () => {
  it('iat equals the injected nowSeconds', () => {
    const now = 1_700_000_000;
    const claims = buildInstallationTokenClaims('123456', now);
    expect(claims.iat).toBe(now);
  });

  it('exp is exactly 600 seconds after now', () => {
    const now = 1_700_000_000;
    const claims = buildInstallationTokenClaims('123456', now);
    expect(claims.exp).toBe(now + 600);
  });

  it('iss equals the appId string', () => {
    const claims = buildInstallationTokenClaims('my-app-id', 0);
    expect(claims.iss).toBe('my-app-id');
  });

  it('exp is always greater than iat', () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = buildInstallationTokenClaims('app', now);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it('works correctly with a zero nowSeconds (deterministic clock)', () => {
    const claims = buildInstallationTokenClaims('zero-app', 0);
    expect(claims.iat).toBe(0);
    expect(claims.exp).toBe(600);
    expect(claims.iss).toBe('zero-app');
  });

  it('iat <= now is satisfied (iat never in the future)', () => {
    const now = 1_700_000_000;
    const claims = buildInstallationTokenClaims('app', now);
    expect(claims.iat).toBeLessThanOrEqual(now);
  });

  it('exp - iat equals exactly 600 for any now value', () => {
    [0, 1, 1_700_000_000, 2_000_000_000].forEach((now) => {
      const claims = buildInstallationTokenClaims('app', now);
      expect(claims.exp - claims.iat).toBe(600);
    });
  });
});
