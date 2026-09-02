import { describe, it, expect, afterEach } from 'vitest';
import { resolveMcpUrls } from './mcp-url';

// resolveMcpUrls reads NEXT_PUBLIC_SUPABASE_URL at call time. Snapshot and
// restore it around every case so the tests don't leak env state into each
// other (or into the rest of the suite).
const KEY = 'NEXT_PUBLIC_SUPABASE_URL';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

// The hardcoded fallback ref baked into mcp-url.ts, used when the env var is
// absent or empty so onboarding still shows a working URL.
const FALLBACK = 'https://pqokxlhvnosogizsjztg.supabase.co/functions/v1/mcp';

describe('resolveMcpUrls', () => {
  it('derives the MCP URL from the project ref in NEXT_PUBLIC_SUPABASE_URL', () => {
    process.env[KEY] = 'https://abcdefghijklmnop.supabase.co';
    const { mcpUrl } = resolveMcpUrls();
    expect(mcpUrl).toBe('https://abcdefghijklmnop.supabase.co/functions/v1/mcp');
  });

  it('derives the webhook URL as the MCP URL plus /webhooks/github', () => {
    process.env[KEY] = 'https://abcdefghijklmnop.supabase.co';
    const { mcpUrl, webhookUrl } = resolveMcpUrls();
    expect(webhookUrl).toBe(`${mcpUrl}/webhooks/github`);
    expect(webhookUrl).toBe('https://abcdefghijklmnop.supabase.co/functions/v1/mcp/webhooks/github');
  });

  it('falls back to the default ref when the env var is unset', () => {
    delete process.env[KEY];
    const { mcpUrl, webhookUrl } = resolveMcpUrls();
    expect(mcpUrl).toBe(FALLBACK);
    expect(webhookUrl).toBe(`${FALLBACK}/webhooks/github`);
  });

  it('falls back to the default ref when the env var is an empty string', () => {
    process.env[KEY] = '';
    expect(resolveMcpUrls().mcpUrl).toBe(FALLBACK);
  });

  it('expands a bare project ref into the hosted Supabase URL', () => {
    // Not the documented form of the env var, but it has always been accepted
    // here — falling back to production instead would silently point a
    // self-hosted deployment at someone else's server.
    process.env[KEY] = 'myref';
    expect(resolveMcpUrls().mcpUrl).toBe('https://myref.supabase.co/functions/v1/mcp');
  });

  it('keeps a non-supabase.co origin verbatim (local dev, self-hosted)', () => {
    // The old ref-splitting turned this into
    // https://http://127.0.0.1:54321.supabase.co/functions/v1/mcp — harmless
    // while it only fed a copy-paste onboarding snippet, wrong now that the
    // OAuth protected-resource document names this URL as its `resource` and
    // clients compare it against the server they are talking to.
    process.env[KEY] = 'http://127.0.0.1:54321';
    expect(resolveMcpUrls().mcpUrl).toBe('http://127.0.0.1:54321/functions/v1/mcp');
  });

  it('drops any path on the configured Supabase URL', () => {
    process.env[KEY] = 'https://abcdefghijklmnop.supabase.co/rest/v1';
    expect(resolveMcpUrls().mcpUrl).toBe(
      'https://abcdefghijklmnop.supabase.co/functions/v1/mcp',
    );
  });

  it('falls back to production for input that is neither a URL nor a ref', () => {
    process.env[KEY] = 'not a url!!';
    expect(resolveMcpUrls().mcpUrl).toBe(FALLBACK);
  });
});
