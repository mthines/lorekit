import { describe, it, expect } from 'vitest';
import { selectWebhookSecrets, type WebhookSecretRow } from './webhook-secret-select.js';

describe('selectWebhookSecrets', () => {
  it('repo match: returns db_repo secrets and the matched repo (case-insensitive)', () => {
    const rows: WebhookSecretRow[] = [
      { secret: 'secret-a', repo: 'mthines/lorekit' },
      { secret: 'secret-b', repo: 'someone/other-repo' },
    ];
    const result = selectWebhookSecrets(rows, 'mthines/lorekit', '');
    expect(result.source).toBe('db_repo');
    expect(result.matchedRepo).toBe('mthines/lorekit');
    expect(result.secrets).toEqual(['secret-a']);
  });

  it('returns every active candidate secret registered for the same matched repo', () => {
    const rows: WebhookSecretRow[] = [
      { secret: 'secret-a', repo: 'mthines/lorekit' },
      { secret: 'secret-b', repo: 'mthines/lorekit' },
    ];
    const result = selectWebhookSecrets(rows, 'mthines/lorekit', '');
    expect(result.source).toBe('db_repo');
    expect(result.secrets).toEqual(['secret-a', 'secret-b']);
  });

  it('org-owned repo regression: matches by full_name alone with no owner-login relationship', () => {
    // Regression: previously the lookup joined on repository.owner.login via
    // auth.users, which fails for org-owned repos (owner login is the org,
    // not any LoreKit user's personal GitHub login). full_name-only matching
    // has no such dependency.
    const rows: WebhookSecretRow[] = [
      { secret: 'org-secret', repo: 'acme-org/service' },
    ];
    const result = selectWebhookSecrets(rows, 'acme-org/service', '');
    expect(result.source).toBe('db_repo');
    expect(result.matchedRepo).toBe('acme-org/service');
    expect(result.secrets).toEqual(['org-secret']);
  });

  it('falls back to legacy null-repo row when no repo row matches', () => {
    const rows: WebhookSecretRow[] = [
      { secret: 'legacy-secret', repo: null },
      { secret: 'other-repo-secret', repo: 'someone/else' },
    ];
    const result = selectWebhookSecrets(rows, 'mthines/lorekit', '');
    expect(result.source).toBe('db_legacy');
    expect(result.matchedRepo).toBeNull();
    expect(result.secrets).toEqual(['legacy-secret']);
  });

  it('falls back to env fallback secret when no DB rows match', () => {
    const result = selectWebhookSecrets([], 'mthines/lorekit', 'env-secret-value');
    expect(result.source).toBe('env');
    expect(result.secrets).toEqual(['env-secret-value']);
    expect(result.matchedRepo).toBeNull();
  });

  it('returns none when neither DB rows nor an env secret exist', () => {
    const result = selectWebhookSecrets([], 'mthines/lorekit', '');
    expect(result.source).toBe('none');
    expect(result.secrets).toEqual([]);
    expect(result.matchedRepo).toBeNull();
  });

  it('does not select repo rows when full_name is undefined, even if a repo row exists', () => {
    const rows: WebhookSecretRow[] = [{ secret: 'secret-a', repo: 'mthines/lorekit' }];
    const result = selectWebhookSecrets(rows, undefined, 'env-secret');
    expect(result.source).toBe('env');
  });
});
