import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveStorageAdapter, createHostedAdapter, createBYODAdapter } from './storage-adapter.js';

// Supabase's createClient validates that the URL is non-empty. These tests are
// pure unit tests that verify adapter metadata flags only — they don't need a
// real Supabase project. Set dummy env vars so createClient doesn't throw.
const DUMMY_URL = 'https://example.supabase.co';
const DUMMY_KEY = 'dummy-anon-key';

describe('createHostedAdapter', () => {
  beforeEach(() => {
    process.env['SUPABASE_URL'] = DUMMY_URL;
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = DUMMY_KEY;
    process.env['SUPABASE_ANON_KEY'] = DUMMY_KEY;
  });

  afterEach(() => {
    delete process.env['SUPABASE_URL'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
    delete process.env['SUPABASE_ANON_KEY'];
  });

  it('returns mode hosted with billing and rate-limit support', () => {
    const adapter = createHostedAdapter();
    expect(adapter.mode).toBe('hosted');
    expect(adapter.supportsHostedBilling).toBe(true);
    expect(adapter.supportsRateLimit).toBe(true);
    expect(adapter.db).not.toBeNull();
  });
});

describe('createBYODAdapter', () => {
  it('returns mode byod without billing or rate-limit support', () => {
    const adapter = createBYODAdapter('https://example.supabase.co', 'anon-key');
    expect(adapter.mode).toBe('byod');
    expect(adapter.supportsHostedBilling).toBe(false);
    expect(adapter.supportsRateLimit).toBe(false);
    expect(adapter.db).not.toBeNull();
  });
});

describe('resolveStorageAdapter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Provide dummy hosted-mode env vars so createHostedAdapter's createClient call
    // does not throw when LOREKIT_STORAGE_URL is absent (the hosted fallback path).
    process.env['SUPABASE_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'dummy-service-key';
    process.env['SUPABASE_ANON_KEY'] = 'dummy-anon-key';
  });

  afterEach(() => {
    // Restore env
    for (const key of [
      'LOREKIT_STORAGE_URL',
      'LOREKIT_STORAGE_ANON_KEY',
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_ANON_KEY',
    ]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns hosted adapter when no LOREKIT_STORAGE_URL is set', () => {
    delete process.env['LOREKIT_STORAGE_URL'];
    delete process.env['LOREKIT_STORAGE_ANON_KEY'];
    const adapter = resolveStorageAdapter();
    expect(adapter.mode).toBe('hosted');
  });

  it('returns BYOD adapter when LOREKIT_STORAGE_URL and LOREKIT_STORAGE_ANON_KEY are both set', () => {
    process.env['LOREKIT_STORAGE_URL'] = 'https://example.supabase.co';
    process.env['LOREKIT_STORAGE_ANON_KEY'] = 'test-anon-key';
    const adapter = resolveStorageAdapter();
    expect(adapter.mode).toBe('byod');
    expect(adapter.supportsHostedBilling).toBe(false);
    expect(adapter.supportsRateLimit).toBe(false);
  });

  it('throws with message naming LOREKIT_STORAGE_ANON_KEY when URL is set without it', () => {
    process.env['LOREKIT_STORAGE_URL'] = 'https://example.supabase.co';
    delete process.env['LOREKIT_STORAGE_ANON_KEY'];
    expect(() => resolveStorageAdapter()).toThrow('LOREKIT_STORAGE_ANON_KEY');
  });
});
