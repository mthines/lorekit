import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const exchangeCodeForSession = vi.fn();
const verifyOtp = vi.fn();
const handleSetupReturn = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => ({
    auth: { exchangeCodeForSession, verifyOtp },
  }),
}));

vi.mock('@/lib/github-installations', () => ({
  handleSetupReturn: (...args: unknown[]) => handleSetupReturn(...args),
}));

const { GET } = await import('./route');

const ORIGIN = 'https://www.lorekit.io';
const get = (search: string) => GET(new NextRequest(`${ORIGIN}/api/auth/callback${search}`));

beforeEach(() => {
  vi.clearAllMocks();
  exchangeCodeForSession.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
  handleSetupReturn.mockResolvedValue(undefined);
});

describe('GET /api/auth/callback — GitHub App Setup-URL return', () => {
  // Regression for the production failure captured on span
  // 522f0077d309a194 (trace e09badefbdc62e1b764d9056ebdbe640):
  //   GET /api/auth/callback?code=…&installation_id=150410512&setup_action=install
  //   → auth.callback.outcome=exchange_failed
  //   → auth.error_code=pkce_code_verifier_not_found
  // GitHub's OAuth `code` was handed to Supabase's PKCE exchange, which cannot
  // succeed, so the installation was never associated and the user was
  // redirected to /overview?error=pkce_code_verifier_not_found.
  const SETUP_RETURN =
    '?code=ddecac6946df5f3899f9&installation_id=150410512&setup_action=install&next=%2Foverview';

  it('never hands the GitHub code to the Supabase PKCE exchange', async () => {
    await get(SETUP_RETURN);
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it('associates the installation and lands on the integrations page', async () => {
    const response = await get(SETUP_RETURN);
    expect(handleSetupReturn).toHaveBeenCalledWith(150410512, 'install', undefined);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/settings/integrations`);
  });

  it('does not redirect the user to an error', async () => {
    const response = await get(SETUP_RETURN);
    expect(response.headers.get('location')).not.toContain('error=');
  });

  it('forwards the correlation-only state parameter when GitHub sends one', async () => {
    await get(`${SETUP_RETURN}&state=corr-123`);
    expect(handleSetupReturn).toHaveBeenCalledWith(150410512, 'install', 'corr-123');
  });
});

describe('GET /api/auth/callback — Supabase flows are unaffected', () => {
  it('still exchanges a plain PKCE code', async () => {
    const response = await get('?code=abc123&next=%2Foverview');
    expect(exchangeCodeForSession).toHaveBeenCalledWith('abc123');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/overview`);
  });

  it('still forwards a failed exchange to the destination with a reason', async () => {
    exchangeCodeForSession.mockResolvedValue({
      data: { user: null },
      error: { code: 'pkce_code_verifier_not_found', name: 'AuthApiError', message: 'nope' },
    });
    const response = await get('?code=abc123&next=%2Foverview');
    expect(response.headers.get('location')).toBe(
      `${ORIGIN}/overview?error=pkce_code_verifier_not_found`,
    );
  });

  it('still treats a provider error as terminal', async () => {
    const response = await get('?error=access_denied&next=%2Foverview');
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe(`${ORIGIN}/overview?error=access_denied`);
  });
});
