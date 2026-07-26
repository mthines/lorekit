import { describe, it, expect, afterEach, vi } from 'vitest';
import { sendInviteEmail } from './invite-email';

// sendInviteEmail reads RESEND_API_KEY / RESEND_FROM / NEXT_PUBLIC_APP_URL at
// call time and calls the global fetch. Snapshot + restore the env and the
// fetch stub around every case so nothing leaks between tests (the
// mcp-url.spec.ts pattern), and so the suite never touches the network.
const ENV_KEYS = ['RESEND_API_KEY', 'RESEND_FROM', 'NEXT_PUBLIC_APP_URL'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) originalEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendInviteEmail', () => {
  it('POSTs a correctly-shaped invite to Resend for an email invite', async () => {
    process.env['RESEND_API_KEY'] = 'test-key';
    process.env['RESEND_FROM'] = 'LoreKit <invites@test.dev>';
    process.env['NEXT_PUBLIC_APP_URL'] = 'https://app.test';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'invitee@example.com',
      orgName: 'Acme Team',
      role: 'member',
      invitedByLabel: 'octocat',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe('LoreKit <invites@test.dev>');
    expect(body.to).toEqual(['invitee@example.com']);
    expect(body.subject).toBe("You've been invited to Acme Team on LoreKit");
    // Both text and html carry org name, role, inviter, and the dashboard link.
    for (const part of [body.text, body.html]) {
      expect(part).toContain('Acme Team');
      expect(part).toContain('member');
      expect(part).toContain('octocat');
      expect(part).toContain('https://app.test/dashboard');
    }
  });

  it('HTML-escapes the org name in the html body (no raw markup injection)', async () => {
    process.env['RESEND_API_KEY'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({
      to: 'invitee@example.com',
      orgName: 'Acme & <b>Partners</b>',
      role: 'member',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    // The html body must carry the escaped form, never the raw tags/ampersand.
    expect(body.html).toContain('Acme &amp; &lt;b&gt;Partners&lt;/b&gt;');
    expect(body.html).not.toContain('<b>Partners</b>');
    // The plain-text body carries the org name verbatim (not HTML).
    expect(body.text).toContain('Acme & <b>Partners</b>');
  });

  it('no-ops (no fetch) when RESEND_API_KEY is unset', async () => {
    delete process.env['RESEND_API_KEY'];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendInviteEmail({ to: 'invitee@example.com', orgName: 'Acme Team', role: 'member' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops for a handle-only / null recipient (no address to send to)', async () => {
    process.env['RESEND_API_KEY'] = 'test-key';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await sendInviteEmail({ to: 'ghhandle', orgName: 'Acme Team', role: 'member' });
    await sendInviteEmail({ to: null, orgName: 'Acme Team', role: 'member' });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never propagates a failed fetch (non-throwing contract)', async () => {
    process.env['RESEND_API_KEY'] = 'test-key';
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      sendInviteEmail({ to: 'invitee@example.com', orgName: 'Acme Team', role: 'member' }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
