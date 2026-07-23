import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAuth, unauthorizedResponse } from './auth.js';

// Mock @supabase/supabase-js
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-abc-123' } },
        error: null,
      }),
    },
  })),
}));

describe('resolveAuth', () => {
  beforeEach(() => {
    process.env['SUPABASE_URL'] = 'http://localhost:54321';
    process.env['SUPABASE_ANON_KEY'] = 'test-anon-key';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'test-service-role-key';
  });

  it('returns null when Authorization header is missing', async () => {
    const result = await resolveAuth(undefined);
    expect(result).toBeNull();
  });

  it('returns null when Authorization header is not Bearer', async () => {
    const result = await resolveAuth('Basic dXNlcjpwYXNz');
    expect(result).toBeNull();
  });

  it('returns service auth context for service-role token', async () => {
    const result = await resolveAuth('Bearer test-service-role-key');
    expect(result).toEqual({ type: 'service' });
  });

  it('returns user auth context for a valid JWT', async () => {
    const result = await resolveAuth('Bearer valid-jwt-token');
    expect(result).not.toBeNull();
    expect(result?.type).toBe('user');
    expect(result?.userId).toBe('user-abc-123');
  });
});

describe('unauthorizedResponse', () => {
  it('returns HTTP 401 with JSON-RPC -32001', async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    const body = await response.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });
});
