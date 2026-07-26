import { describe, it, expect } from 'vitest';
import {
  VERIFY_EVENT,
  buildVerifyPayload,
  signBody,
  interpretVerifyStatus,
} from './webhook-verify';

describe('buildVerifyPayload', () => {
  it('is valid JSON carrying the repo as repository.full_name', () => {
    const parsed = JSON.parse(buildVerifyPayload('mthines/lorekit'));
    expect(parsed.repository.full_name).toBe('mthines/lorekit');
  });

  it('preserves the exact repo string (the only field the handler reads)', () => {
    const parsed = JSON.parse(buildVerifyPayload('acme/Repo.With-Dots'));
    expect(parsed.repository.full_name).toBe('acme/Repo.With-Dots');
  });
});

describe('signBody', () => {
  it('produces a GitHub-style sha256=<64 hex> header value', async () => {
    const sig = await signBody('a-secret', buildVerifyPayload('mthines/lorekit'));
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('is deterministic for the same secret + body', async () => {
    const body = buildVerifyPayload('mthines/lorekit');
    expect(await signBody('s', body)).toBe(await signBody('s', body));
  });

  it('changes when the secret changes', async () => {
    const body = buildVerifyPayload('mthines/lorekit');
    expect(await signBody('one', body)).not.toBe(await signBody('two', body));
  });

  // The whole feature hinges on the edge function accepting this signature.
  // Re-verify it exactly the way supabase/functions/mcp/webhook.ts does
  // (crypto.subtle.verify over the raw body bytes) so a signing regression
  // fails here instead of silently returning 401 in production.
  it('verifies against crypto.subtle the way the edge function does', async () => {
    const secret = 'deadbeef'.repeat(8);
    const body = buildVerifyPayload('mthines/lorekit');
    const sig = await signBody(secret, body);
    const hex = sig.slice('sha256='.length);
    const sigBytes = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
    expect(ok).toBe(true);
  });

  it('a signature made with the wrong secret does NOT verify', async () => {
    const body = buildVerifyPayload('mthines/lorekit');
    const sig = await signBody('right', body);
    const hex = sig.slice('sha256='.length);
    const sigBytes = new Uint8Array(hex.match(/.{2}/g)!.map((h) => parseInt(h, 16)));

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('wrong'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(body));
    expect(ok).toBe(false);
  });
});

describe('interpretVerifyStatus', () => {
  it('treats 200 as success (endpoint live, secret accepted)', () => {
    const r = interpretVerifyStatus(200);
    expect(r.ok).toBe(true);
    expect(r.code).toBe('reachable_ok');
    expect(r.status).toBe(200);
  });

  it('treats 401 as a rejected signature', () => {
    const r = interpretVerifyStatus(401);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('signature_rejected');
  });

  it('treats any other status as an endpoint error and surfaces the code', () => {
    const r = interpretVerifyStatus(500);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('endpoint_error');
    expect(r.message).toContain('500');
  });

  it('does not treat 404 as success', () => {
    expect(interpretVerifyStatus(404).ok).toBe(false);
  });
});

describe('VERIFY_EVENT', () => {
  // `ping` is deliberately an unsupported event so a valid signature returns
  // 200 without writing a candidate lesson — verification must not pollute lore.
  it('is "ping" (an unsupported event ⇒ no memory write)', () => {
    expect(VERIFY_EVENT).toBe('ping');
  });
});
