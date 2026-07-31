import { describe, it, expect } from 'vitest';
import { DRY_RUN_HEADER, isDryRunHeader } from './dry-run.ts';

describe('isDryRunHeader', () => {
  it('treats an absent header as real execution (false)', () => {
    // The default MUST be false so existing REST/API clients that never send
    // the header keep executing writes — dry-run is opt-in.
    expect(isDryRunHeader(null)).toBe(false);
    expect(isDryRunHeader(undefined)).toBe(false);
    expect(isDryRunHeader('')).toBe(false);
  });

  it('recognises truthy values case- and whitespace-insensitively', () => {
    for (const v of ['true', 'TRUE', 'True', ' true ', '1', 'yes', 'on', 'ON']) {
      expect(isDryRunHeader(v)).toBe(true);
    }
  });

  it('treats explicit falsy / unknown values as real execution', () => {
    for (const v of ['false', '0', 'no', 'off', 'maybe', 'dry-run']) {
      expect(isDryRunHeader(v)).toBe(false);
    }
  });

  it('exposes the canonical header name', () => {
    expect(DRY_RUN_HEADER).toBe('X-LoreKit-Dry-Run');
  });
});
