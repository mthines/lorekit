// Boot-the-shim integration test for `lorekit serve`'s local REST shim.
// Every response is parsed through the REAL `@lorekit/schemas` zod schema
// (AC-15) — a devDependency-only import (see packages/cli/package.json),
// never shipped in the published CLI (AC-13 stays satisfied: `dependencies`
// is empty and nothing under `src/`/`bin/` imports it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTwoTierStore } from '../src/store/local.mjs';
import { createRoutes } from '../src/serve/routes.mjs';
import { createShimServer } from '../src/serve/http.mjs';
import {
  MemoryPageResponseSchema,
  MemoryEntrySchema,
  ScopesResponseSchema,
  FacetsResponseSchema,
  ActivityResponseSchema,
} from '@lorekit/schemas/memory';

let server;
let baseUrl;
let store;

before(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-serve-'));
  store = createTwoTierStore({ home, project: null });

  // Seed a variety of rows so every filter/pagination/facet/activity path has
  // something real to exercise.
  await store.write({ scope: 'global', key: 'alpha', value: 'prefer guard clauses', tags: ['perf', 'style'], source_agent: 'claude', trigger: 'stuck-loop' });
  await store.write({ scope: 'global', key: 'beta', value: 'avoid nested ternaries', tags: ['style'], source_agent: 'aw' });
  await store.write({ scope: 'repo::acme/widget', key: 'gamma', value: 'ci flakiness workaround', tags: ['ci'], source_agent: 'aw', origin_repo: 'acme/widget', origin_branch: 'main', origin_pr: 42 });
  await store.write({ scope: 'repo::acme/widget', key: 'to-archive', value: 'temporary note' });
  await store.archive({ scope: 'repo::acme/widget', key: 'to-archive' });

  const dispatch = createRoutes({ store });
  server = createShimServer(dispatch);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/functions/v1`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(path, init) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer anything' }, ...init });
  return res;
}

test('list: GET /memories with no filters returns a schema-valid MemoryPageResponse, newest-first (not the default archived one)', async () => {
  const res = await get('/memories');
  assert.equal(res.status, 200);
  const body = await res.json();
  const page = MemoryPageResponseSchema.parse(body);
  const keys = page.entries.map((e) => e.key);
  assert.ok(keys.includes('alpha'));
  assert.ok(keys.includes('beta'));
  assert.ok(keys.includes('gamma'));
  assert.ok(!keys.includes('to-archive'), 'an archived row must not appear in the default (live) listing');
  // newest-first: gamma was written after alpha/beta.
  assert.ok(keys.indexOf('gamma') < keys.indexOf('alpha'));
});

test('GET /memories honours the scope, tags, and source_agent filters together (AND across dimensions)', async () => {
  const res = await get('/memories?scope=repo::acme/widget&source_agent=aw&tags=ci');
  const page = MemoryPageResponseSchema.parse(await res.json());
  assert.deepEqual(page.entries.map((e) => e.key), ['gamma']);
});

test('GET /memories honours q (substring over key or value)', async () => {
  const res = await get('/memories?q=ternaries');
  const page = MemoryPageResponseSchema.parse(await res.json());
  assert.deepEqual(page.entries.map((e) => e.key), ['beta']);
});

test('GET /memories?archived=true lists the archived partition only', async () => {
  const res = await get('/memories?archived=true');
  const page = MemoryPageResponseSchema.parse(await res.json());
  assert.deepEqual(page.entries.map((e) => e.key), ['to-archive']);
});

test('pagination: hasMore + nextCursor page through the full set with no overlap or gap', async () => {
  // Seed enough rows in their own scope to force multiple pages deterministically.
  for (let i = 0; i < 5; i++) {
    await store.write({ scope: 'project::pagination-test', key: `p-${i}`, value: `row ${i}` });
  }
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 10; guard++) {
    const qs = new URLSearchParams({ scope: 'project::pagination-test', limit: '2', ...(cursor ? { cursor } : {}) });
    const res = await get(`/memories?${qs}`);
    const page = MemoryPageResponseSchema.parse(await res.json());
    seen.push(...page.entries.map((e) => e.key));
    if (!page.hasMore) break;
    assert.ok(page.nextCursor);
    cursor = page.nextCursor;
  }
  assert.equal(new Set(seen).size, seen.length, 'no key must repeat across pages');
  assert.deepEqual(new Set(seen), new Set(['p-0', 'p-1', 'p-2', 'p-3', 'p-4']));
});

test('scopes: GET /memories/scopes returns a schema-valid ScopesResponse from store.listScopes()', async () => {
  const res = await get('/memories/scopes');
  assert.equal(res.status, 200);
  const body = ScopesResponseSchema.parse(await res.json());
  const globalScope = body.scopes.find((s) => s.scope === 'global');
  assert.ok(globalScope, 'the global scope must be present');
  assert.equal(globalScope.count, 2);
});

test('facets: GET /memories/facets returns a schema-valid, drill-down FacetsResponse', async () => {
  const res = await get('/memories/facets');
  const body = FacetsResponseSchema.parse(await res.json());
  const sourceAgentAw = body.facets.find((f) => f.facet === 'source_agent' && f.value === 'aw');
  assert.ok(sourceAgentAw);
  assert.equal(sourceAgentAw.count, 2); // beta and gamma
});

test('activity: GET /memories/activity?bucket=day returns a schema-valid ActivityResponse', async () => {
  const res = await get('/memories/activity?bucket=day');
  const body = ActivityResponseSchema.parse(await res.json());
  assert.equal(body.bucket, 'day');
  const total = body.buckets.reduce((s, b) => s + b.count, 0);
  assert.ok(total >= 3);
});

test('id round trip: GET /memories/:id resolves the synthetic id back to its row', async () => {
  const listRes = await get('/memories?scope=global&key=alpha');
  const page = MemoryPageResponseSchema.parse(await listRes.json());
  const alpha = page.entries.find((e) => e.key === 'alpha');
  assert.ok(alpha);

  const getRes = await get(`/memories/${alpha.id}`);
  assert.equal(getRes.status, 200);
  const entry = MemoryEntrySchema.parse(await getRes.json());
  assert.equal(entry.scope, 'global');
  assert.equal(entry.key, 'alpha');
});

test('GET /memories/:id 404s for an id no row produces', async () => {
  const res = await get('/memories/00000000-0000-5000-8000-000000000000');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'not_found');
});

test('GET /memories/:id 404s for an archived row (not resolvable via GET)', async () => {
  const listRes = await get('/memories/scopes'); // just to warm the connection
  void listRes;
  const raw = (await store.listRaw({ scope: 'repo::acme/widget' })).entries.find((e) => e.key === 'to-archive');
  const { syntheticId } = await import('../src/serve/synthetic-id.mjs');
  const id = syntheticId(raw.scope, raw.key);
  const res = await get(`/memories/${id}`);
  assert.equal(res.status, 404);
});

test('PATCH /memories/:id updates the value and returns the updated MemoryEntry', async () => {
  const listRes = await get('/memories?scope=global&key=beta');
  const page = MemoryPageResponseSchema.parse(await listRes.json());
  const beta = page.entries.find((e) => e.key === 'beta');

  const patchRes = await fetch(`${baseUrl}/memories/${beta.id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'updated value' }),
  });
  assert.equal(patchRes.status, 200);
  const updated = MemoryEntrySchema.parse(await patchRes.json());
  assert.equal(updated.value, 'updated value');

  const reread = await get(`/memories/${beta.id}`);
  const rereadEntry = MemoryEntrySchema.parse(await reread.json());
  assert.equal(rereadEntry.value, 'updated value', 'the .md file must reflect the patch on the next read');
});

test('PATCH translates ttl_days into expires_at, never a literal column', async () => {
  await store.write({ scope: 'global', key: 'ttl-target', value: 'expires eventually' });
  const listRes = await get('/memories?scope=global&key=ttl-target');
  const page = MemoryPageResponseSchema.parse(await listRes.json());
  const row = page.entries.find((e) => e.key === 'ttl-target');
  assert.equal(row.expires_at, null);

  const patchRes = await fetch(`${baseUrl}/memories/${row.id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl_days: 30 }),
  });
  const updated = MemoryEntrySchema.parse(await patchRes.json());
  assert.ok(updated.expires_at, 'ttl_days must translate into a real expires_at timestamp');

  const clearRes = await fetch(`${baseUrl}/memories/${row.id}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear_ttl: true }),
  });
  const cleared = MemoryEntrySchema.parse(await clearRes.json());
  assert.equal(cleared.expires_at, null, 'clear_ttl must win and make the row permanent again');
});

test('PATCH /memories/:id 404s for an unknown id', async () => {
  const res = await fetch(`${baseUrl}/memories/00000000-0000-5000-8000-000000000000`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x' }),
  });
  assert.equal(res.status, 404);
});

test('archive + restore round-trip on the local file, reflected on the next list', async () => {
  await store.write({ scope: 'global', key: 'round-trip', value: 'will be archived then restored' });

  const deleteRes = await fetch(`${baseUrl}/memories?scope=global&key=round-trip`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer x' },
  });
  assert.equal(deleteRes.status, 204);

  const afterDelete = MemoryPageResponseSchema.parse(await (await get('/memories?scope=global&key=round-trip')).json());
  assert.equal(afterDelete.entries.length, 0, 'an archived row must vanish from the default listing');

  const archivedView = MemoryPageResponseSchema.parse(
    await (await get('/memories?scope=global&key=round-trip&archived=true')).json(),
  );
  assert.equal(archivedView.entries.length, 1);

  const restoreRes = await fetch(`${baseUrl}/memories/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'global', key: 'round-trip' }),
  });
  assert.equal(restoreRes.status, 200);
  const restoreBody = await restoreRes.json();
  assert.equal(restoreBody.restored, true);

  const afterRestore = MemoryPageResponseSchema.parse(await (await get('/memories?scope=global&key=round-trip')).json());
  assert.equal(afterRestore.entries.length, 1, 'a restored row must reappear in the default listing');
});

test('restoring a never-archived row 404s rather than silently no-opping', async () => {
  await store.write({ scope: 'global', key: 'never-archived', value: 'still live' });
  const res = await fetch(`${baseUrl}/memories/restore`, {
    method: 'POST',
    headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'global', key: 'never-archived' }),
  });
  assert.equal(res.status, 404);
});

test('DELETE with force=true hard-deletes even an already-archived row', async () => {
  await store.write({ scope: 'global', key: 'force-target', value: 'to be purged' });
  await store.archive({ scope: 'global', key: 'force-target' });

  const res = await fetch(`${baseUrl}/memories?scope=global&key=force-target&force=true`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer x' },
  });
  assert.equal(res.status, 204);

  const archivedView = MemoryPageResponseSchema.parse(
    await (await get('/memories?scope=global&key=force-target&archived=true')).json(),
  );
  assert.equal(archivedView.entries.length, 0, 'a force-deleted row must vanish even from the archived partition');
});

test('an unknown route returns the { error, code } 404 envelope', async () => {
  const res = await get('/nope');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, 'not_found');
});

test('OPTIONS preflight is answered without touching the store', async () => {
  const res = await fetch(`${baseUrl}/memories`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.ok(res.headers.get('access-control-allow-methods'));
});
