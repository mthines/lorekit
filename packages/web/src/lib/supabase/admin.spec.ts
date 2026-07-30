import { describe, it, expect, afterEach } from 'vitest';
import {
  createAdminClient,
  isAdminConfigured,
  SupabaseAdminConfigError,
  SERVICE_ROLE_KEY_ENV,
  SUPABASE_URL_ENV,
} from './admin';

// Both vars are read at call time. Snapshot and restore them around every case
// so the tests don't leak env state into each other (mcp-url.spec.ts pattern).
const originals = {
  [SUPABASE_URL_ENV]: process.env[SUPABASE_URL_ENV],
  [SERVICE_ROLE_KEY_ENV]: process.env[SERVICE_ROLE_KEY_ENV],
};

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createAdminClient', () => {
  it('builds a client when both env vars are set', () => {
    process.env[SUPABASE_URL_ENV] = 'https://abcdefghijklmnop.supabase.co';
    process.env[SERVICE_ROLE_KEY_ENV] = 'service-role-key';
    expect(createAdminClient().auth).toBeDefined();
  });

  it('throws a named error naming the missing service-role key', () => {
    process.env[SUPABASE_URL_ENV] = 'https://abcdefghijklmnop.supabase.co';
    delete process.env[SERVICE_ROLE_KEY_ENV];
    expect(() => createAdminClient()).toThrow(SupabaseAdminConfigError);
    expect(() => createAdminClient()).toThrow(SERVICE_ROLE_KEY_ENV);
  });

  it('treats an empty service-role key as missing', () => {
    process.env[SUPABASE_URL_ENV] = 'https://abcdefghijklmnop.supabase.co';
    process.env[SERVICE_ROLE_KEY_ENV] = '';
    expect(() => createAdminClient()).toThrow(SupabaseAdminConfigError);
  });

  it('throws when the Supabase URL is missing', () => {
    delete process.env[SUPABASE_URL_ENV];
    process.env[SERVICE_ROLE_KEY_ENV] = 'service-role-key';
    expect(() => createAdminClient()).toThrow(SUPABASE_URL_ENV);
  });

  it('exposes a stable error code and the missing env var', () => {
    const error = new SupabaseAdminConfigError(SERVICE_ROLE_KEY_ENV);
    expect(error.code).toBe('supabase_admin_not_configured');
    expect(error.missingEnv).toBe(SERVICE_ROLE_KEY_ENV);
  });
});

describe('isAdminConfigured', () => {
  it('is true only when both vars are non-empty', () => {
    process.env[SUPABASE_URL_ENV] = 'https://abcdefghijklmnop.supabase.co';
    process.env[SERVICE_ROLE_KEY_ENV] = 'service-role-key';
    expect(isAdminConfigured()).toBe(true);

    process.env[SERVICE_ROLE_KEY_ENV] = '';
    expect(isAdminConfigured()).toBe(false);
  });
});
