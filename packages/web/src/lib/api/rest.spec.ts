import { describe, it, expect, beforeEach, vi } from 'vitest';
import { restFetch, restBaseUrl, RestApiError, RestConfigError } from './rest';

const SUPABASE_URL = 'https://project.supabase.co';
const BASE = `${SUPABASE_URL}/functions/v1`;

interface Recorded { url: string; init: RequestInit }

const calls: Recorded[] = [];
let responder: () => Response;

beforeEach(() => {
  calls.length = 0;
  process.env['NEXT_PUBLIC_SUPABASE_URL'] = SUPABASE_URL;
  responder = () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  vi.stubGlobal('fetch', ((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responder());
  }) as unknown as typeof fetch);
});

describe('restBaseUrl', () => {
  it('appends the edge-function root to the project URL', () => {
    expect(restBaseUrl()).toBe(BASE);
  });

  it('tolerates a trailing slash on the configured URL', () => {
    process.env['NEXT_PUBLIC_SUPABASE_URL'] = `${SUPABASE_URL}/`;
    expect(restBaseUrl()).toBe(BASE);
  });

  it('throws a named configuration error when the project URL is unset', () => {
    delete process.env['NEXT_PUBLIC_SUPABASE_URL'];
    expect(() => restBaseUrl()).toThrow(RestConfigError);
  });
});

describe('restFetch', () => {
  it('sends the access token as a bearer credential', async () => {
    await restFetch('/memories/scopes', { accessToken: 'jwt' });
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt');
  });

  it('omits absent query params instead of sending them as "undefined"', async () => {
    await restFetch('/memories', {
      accessToken: 'jwt',
      query: { scope: 'global', q: undefined, cursor: null, key: '' },
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('scope')).toBe('global');
    expect([...url.searchParams.keys()]).toEqual(['scope']);
  });

  it('encodes a scope so its `::` separator survives the query string', async () => {
    await restFetch('/memories', { accessToken: 'jwt', query: { scope: 'repo::acme/lore' } });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('scope')).toBe('repo::acme/lore');
  });

  it('never caches a per-user read', async () => {
    await restFetch('/memories', { accessToken: 'jwt' });
    expect(calls[0]!.init.cache).toBe('no-store');
  });

  it('sends a JSON body with its content type', async () => {
    await restFetch('/memories/restore', {
      accessToken: 'jwt',
      method: 'POST',
      body: { scope: 'global', key: 'k' },
    });
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.body).toBe('{"scope":"global","key":"k"}');
  });

  it('resolves to undefined on 204, which has no body to parse', async () => {
    responder = () => new Response(null, { status: 204 });
    await expect(restFetch('/memories', { accessToken: 'jwt', method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('raises the API error envelope, preserving status, message and code', async () => {
    responder = () => new Response(JSON.stringify({ error: 'Memory not found', code: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });

    const err = await restFetch('/memories/x', { accessToken: 'jwt' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestApiError);
    expect((err as RestApiError).status).toBe(404);
    expect((err as RestApiError).message).toBe('Memory not found');
    expect((err as RestApiError).code).toBe('not_found');
  });

  it('still raises something usable when the body is not JSON', async () => {
    // A function that fails to boot answers with an HTML error page, not the
    // error envelope — the caller must not get "Unexpected token <" instead.
    responder = () => new Response('<html>Boot error</html>', { status: 503, statusText: 'Service Unavailable' });

    const err = await restFetch('/memories', { accessToken: 'jwt' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestApiError);
    expect((err as RestApiError).status).toBe(503);
    expect((err as RestApiError).message).toBe('Service Unavailable');
  });
});
