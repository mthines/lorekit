import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveStorageAdapter, createHostedAdapter, createBYODAdapter, storageUserId } from './storage-adapter.js';

// These are pure unit tests that verify adapter metadata flags only.
// Mock createClient so the real Supabase client (which needs native WebSocket
// or the `ws` package, unavailable on Node 20 in CI) is never instantiated.
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ _mock: true })),
}));

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

  it('throws when no JWT is passed and SUPABASE_SERVICE_ROLE_KEY is empty', () => {
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = '';
    expect(() => createHostedAdapter()).toThrow('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('does NOT throw when a JWT is passed even if SUPABASE_SERVICE_ROLE_KEY is empty', () => {
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = '';
    expect(() => createHostedAdapter('some-jwt')).not.toThrow();
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

describe('createBYODAdapter with service key', () => {
  it('preserves byod metadata flags when service key is provided', () => {
    const adapter = createBYODAdapter('https://example.supabase.co', 'anon-key', 'service-key');
    expect(adapter.mode).toBe('byod');
    // Service key must not accidentally enable hosted billing or rate-limiting.
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
    for (const key of [
      'LOREKIT_STORAGE_URL',
      'LOREKIT_STORAGE_ANON_KEY',
      'LOREKIT_STORAGE_SERVICE_KEY',
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

  it('throws naming LOREKIT_STORAGE_SERVICE_KEY when URL and only the anon key are set', () => {
    // An anon-key client writes (memory_write is SECURITY DEFINER) but reads
    // back nothing (the read policies need auth.uid()), so this must fail at
    // configuration rather than serve empty reads that look healthy.
    process.env['LOREKIT_STORAGE_URL'] = 'https://example.supabase.co';
    process.env['LOREKIT_STORAGE_ANON_KEY'] = 'test-anon-key';
    delete process.env['LOREKIT_STORAGE_SERVICE_KEY'];
    expect(() => resolveStorageAdapter()).toThrow('LOREKIT_STORAGE_SERVICE_KEY');
  });

  it('throws naming LOREKIT_STORAGE_SERVICE_KEY when URL is set without any key', () => {
    process.env['LOREKIT_STORAGE_URL'] = 'https://example.supabase.co';
    delete process.env['LOREKIT_STORAGE_ANON_KEY'];
    delete process.env['LOREKIT_STORAGE_SERVICE_KEY'];
    expect(() => resolveStorageAdapter()).toThrow('LOREKIT_STORAGE_SERVICE_KEY');
  });

  it('returns a BYOD adapter from the URL and service key alone', () => {
    process.env['LOREKIT_STORAGE_URL'] = 'https://example.supabase.co';
    delete process.env['LOREKIT_STORAGE_ANON_KEY'];
    process.env['LOREKIT_STORAGE_SERVICE_KEY'] = 'test-service-key';
    const adapter = resolveStorageAdapter();
    expect(adapter.mode).toBe('byod');
    expect(adapter.supportsHostedBilling).toBe(false);
    expect(adapter.supportsRateLimit).toBe(false);
  });

  it('passes LOREKIT_STORAGE_SERVICE_KEY through to BYOD adapter when set', () => {
    process.env['LOREKIT_STORAGE_URL'] = 'https://example.supabase.co';
    process.env['LOREKIT_STORAGE_ANON_KEY'] = 'test-anon-key';
    process.env['LOREKIT_STORAGE_SERVICE_KEY'] = 'test-service-key';
    const adapter = resolveStorageAdapter();
    expect(adapter.mode).toBe('byod');
    // Service key must not accidentally enable hosted billing or rate-limiting.
    expect(adapter.supportsHostedBilling).toBe(false);
    expect(adapter.supportsRateLimit).toBe(false);
  });
});

describe('storageUserId', () => {
  const USER = '6f1c2a9e-0000-4000-8000-000000000001';

  it('scopes an api_key caller by its id in both modes', () => {
    expect(storageUserId('hosted', { type: 'api_key', userId: USER })).toBe(USER);
    expect(storageUserId('byod', { type: 'api_key', userId: USER })).toBe(USER);
  });

  it('stamps a hosted JWT caller with its id — memory_write reads p_user_id = null as an ownerless row', () => {
    expect(storageUserId('hosted', { type: 'user', userId: USER })).toBe(USER);
  });

  it('leaves a hosted JWT caller with no resolved id to RLS rather than refusing it', () => {
    expect(storageUserId('hosted', { type: 'user' })).toBeNull();
  });

  it('scopes a BYOD JWT caller by its id — the storage client carries no JWT for RLS to read', () => {
    expect(storageUserId('byod', { type: 'user', userId: USER })).toBe(USER);
  });

  it('refuses a BYOD JWT caller with no resolved id instead of letting it through unscoped', () => {
    expect(() => storageUserId('byod', { type: 'user' })).toThrow('BYOD');
  });

  it('leaves the service tier unscoped in both modes', () => {
    expect(storageUserId('hosted', { type: 'service' })).toBeNull();
    expect(storageUserId('byod', { type: 'service' })).toBeNull();
  });
});
