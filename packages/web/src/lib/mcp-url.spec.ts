import { describe, it, expect, afterEach } from 'vitest';
import { resolveMcpUrls } from './mcp-url';

// resolveMcpUrls reads NEXT_PUBLIC_SUPABASE_URL at call time. Snapshot and
// restore it around every case so the tests don't leak env state into each
// other (or into the rest of the suite).
const KEY = 'NEXT_PUBLIC_SUPABASE_URL';
const LOCAL_FLAG = 'NEXT_PUBLIC_USE_LOCAL_SUPABASE';
const original = process.env[KEY];
const originalFlag = process.env[LOCAL_FLAG];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  if (originalFlag === undefined) delete process.env[LOCAL_FLAG];
  else process.env[LOCAL_FLAG] = originalFlag;
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

  it('ignores a trailing slash on a *.supabase.co URL', () => {
    process.env[KEY] = 'https://abcdefghijklmnop.supabase.co/';
    expect(resolveMcpUrls().mcpUrl).toBe('https://abcdefghijklmnop.supabase.co/functions/v1/mcp');
  });

  it('derives the MCP URL from a self-hosted custom domain', () => {
    process.env[KEY] = 'https://db.example.com';
    const { mcpUrl, webhookUrl } = resolveMcpUrls();
    expect(mcpUrl).toBe('https://db.example.com/functions/v1/mcp');
    expect(webhookUrl).toBe('https://db.example.com/functions/v1/mcp/webhooks/github');
  });

  it('ignores a trailing slash on a custom domain', () => {
    process.env[KEY] = 'https://db.example.com/';
    expect(resolveMcpUrls().mcpUrl).toBe('https://db.example.com/functions/v1/mcp');
  });

  it('keeps the scheme and port of a local http Supabase', () => {
    process.env[KEY] = 'http://127.0.0.1:54321';
    expect(resolveMcpUrls().mcpUrl).toBe('http://127.0.0.1:54321/functions/v1/mcp');
  });

  it('keeps a reverse-proxy base path, minus its trailing slash', () => {
    process.env[KEY] = 'https://example.com/supabase/';
    expect(resolveMcpUrls().mcpUrl).toBe('https://example.com/supabase/functions/v1/mcp');
  });

  it.each([
    ['a bare word that is not a URL', 'myref'],
    ['whitespace only', '   '],
    ['a non-http scheme', 'ftp://db.example.com'],
  ])('falls back to the hosted URL for %s', (_label, value) => {
    process.env[KEY] = value;
    expect(resolveMcpUrls().mcpUrl).toBe(FALLBACK);
  });

  it('follows the local stack when NEXT_PUBLIC_USE_LOCAL_SUPABASE is set, like every other client', () => {
    process.env[KEY] = 'https://abcdefghijklmnop.supabase.co';
    process.env[LOCAL_FLAG] = 'true';
    expect(resolveMcpUrls().mcpUrl).toBe('http://127.0.0.1:54321/functions/v1/mcp');
  });
});
