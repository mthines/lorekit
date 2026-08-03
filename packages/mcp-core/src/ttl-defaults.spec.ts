import { describe, it, expect } from 'vitest';
import {
  WEBHOOK_TTL_DAYS_BY_TIER,
  webhookSignalTier,
  webhookTtlDays,
} from './ttl-defaults.js';
import { TTL_MAX_DAYS, TTL_MIN_DAYS } from './ttl.js';

describe('webhookSignalTier', () => {
  it('grades a resolved review thread as high — the author acted on the finding', () => {
    expect(webhookSignalTier('pull_request_review_thread', 'resolved')).toBe('high');
  });

  it('grades a submitted review as medium', () => {
    expect(webhookSignalTier('pull_request_review', 'submitted')).toBe('medium');
  });

  it.each([
    ['pull_request_review_comment', 'created'],
    ['issue_comment', 'created'],
  ])('grades a created %s as low', (event, action) => {
    expect(webhookSignalTier(event, action)).toBe('low');
  });

  it('falls through to low for a pair the action gate would not have accepted', () => {
    // Reached only if this module and signal-filter drift. Under-retaining an
    // unexpected row beats throwing on a delivery GitHub would then redeliver.
    expect(webhookSignalTier('pull_request_review_comment', 'edited')).toBe('low');
    expect(webhookSignalTier('totally_unknown', 'whatever')).toBe('low');
  });
});

describe('webhookTtlDays', () => {
  it('returns the tier default when no override is configured', () => {
    expect(webhookTtlDays('pull_request_review_thread', 'resolved')).toBe(90);
    expect(webhookTtlDays('pull_request_review', 'submitted')).toBe(30);
    expect(webhookTtlDays('issue_comment', 'created')).toBe(14);
  });

  it.each([undefined, null])('treats %s as "no override", not "never expire"', (override) => {
    expect(webhookTtlDays('issue_comment', 'created', override)).toBe(14);
  });

  it('honours a valid per-repo override over the tier default', () => {
    expect(webhookTtlDays('issue_comment', 'created', 7)).toBe(7);
    expect(webhookTtlDays('pull_request_review_thread', 'resolved', 7)).toBe(7);
  });

  it('accepts the override at both bounds', () => {
    expect(webhookTtlDays('issue_comment', 'created', TTL_MIN_DAYS)).toBe(1);
    expect(webhookTtlDays('issue_comment', 'created', TTL_MAX_DAYS)).toBe(365);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['above the ceiling', TTL_MAX_DAYS + 1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('ignores an invalid override (%s) and falls back to the tier default', (_label, override) => {
    // Fail-safe on purpose: the override arrives from a DB row a UI wrote, and a
    // misconfigured repo must not be able to stop its own webhook ingest.
    expect(webhookTtlDays('issue_comment', 'created', override as number)).toBe(14);
  });

  it('always returns a TTL in the range memory_write accepts', () => {
    for (const days of Object.values(WEBHOOK_TTL_DAYS_BY_TIER)) {
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThanOrEqual(TTL_MIN_DAYS);
      expect(days).toBeLessThanOrEqual(TTL_MAX_DAYS);
    }
  });

  it('grades strictly: a higher tier never retains for less than a lower one', () => {
    expect(WEBHOOK_TTL_DAYS_BY_TIER.high).toBeGreaterThan(WEBHOOK_TTL_DAYS_BY_TIER.medium);
    expect(WEBHOOK_TTL_DAYS_BY_TIER.medium).toBeGreaterThan(WEBHOOK_TTL_DAYS_BY_TIER.low);
  });
});

describe('tier coverage vs the action gate', () => {
  // Every pair classifyWebhookAction accepts must be graded by NAME here, not by
  // the `low` fallback — otherwise a newly accepted event silently gets the
  // shortest retention. That the list below matches the gate exactly is asserted
  // where both modules are importable: packages/mcp-server/src/webhooks/github.spec.ts.
  const ACCEPTED: ReadonlyArray<readonly [string, string, number]> = [
    ['pull_request_review_thread', 'resolved', 90],
    ['pull_request_review', 'submitted', 30],
    ['pull_request_review_comment', 'created', 14],
    ['issue_comment', 'created', 14],
  ];

  it.each(ACCEPTED)('%s/%s retains for %i days', (event, action, days) => {
    expect(webhookTtlDays(event, action)).toBe(days);
  });
});
