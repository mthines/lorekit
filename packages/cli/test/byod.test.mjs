import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeByodStorage } from '../src/shared/byod.mjs';

// A fetch stand-in: records the request and answers with `status` + `body`.
function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('not json');
        return body;
      },
    };
  };
}

const URL_ = 'https://abcdefgh.supabase.co';

test('a 200 from the memories table is ready, and the key rides both headers', async () => {
  const calls = [];
  const r = await probeByodStorage({ url: URL_, key: 'k', fetchImpl: fakeFetch(200, [], calls) });
  assert.deepEqual(r, { state: 'ready' });
  assert.equal(calls[0].url, `${URL_}/rest/v1/memories?select=id&limit=1`);
  assert.equal(calls[0].init.headers.apikey, 'k');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
});

test('a trailing slash on the URL does not double up', async () => {
  const calls = [];
  await probeByodStorage({ url: `${URL_}/`, key: 'k', fetchImpl: fakeFetch(200, [], calls) });
  assert.equal(calls[0].url, `${URL_}/rest/v1/memories?select=id&limit=1`);
});

test('a missing table is no-schema under both PostgREST codes', async () => {
  for (const code of ['42P01', 'PGRST205']) {
    const r = await probeByodStorage({ url: URL_, key: 'k', fetchImpl: fakeFetch(404, { code, message: 'x' }) });
    assert.equal(r.state, 'no-schema', code);
  }
});

test('a rejected key is an error carrying the status and message', async () => {
  const r = await probeByodStorage({ url: URL_, key: 'bad', fetchImpl: fakeFetch(401, { message: 'Invalid API key' }) });
  assert.deepEqual(r, { state: 'error', detail: 'HTTP 401: Invalid API key' });
});

test('a non-JSON error body is reported by status alone', async () => {
  const r = await probeByodStorage({ url: URL_, key: 'k', fetchImpl: fakeFetch(502, undefined) });
  assert.deepEqual(r, { state: 'error', detail: 'HTTP 502' });
});

test('a network failure is an error, never a throw', async () => {
  const r = await probeByodStorage({
    url: URL_,
    key: 'k',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  assert.deepEqual(r, { state: 'error', detail: 'could not connect: getaddrinfo ENOTFOUND' });
});

test('an unparseable URL is an error without a request', async () => {
  const calls = [];
  const r = await probeByodStorage({ url: 'not a url', key: 'k', fetchImpl: fakeFetch(200, [], calls) });
  assert.equal(r.state, 'error');
  assert.equal(calls.length, 0);
});
