// `lorekit write --edit` (migration 00126's CLI side): a maintenance write that
// changes an existing memory without counting a sighting.
//   • local store  — through the real binary: an edit keeps seen_count, a plain
//                    write still increments it, an edit of a missing key fails
//   • remote store — the request carries `edit: true` only on an edit, and a
//                    404 `not_found` comes back as the caller's `code`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteStore } from '../src/store/remote.mjs';
import { write } from '../src/commands/write.mjs';
import { refuseUnacknowledgedEdit } from '../src/commands/mcp-server.mjs';
import { setWriters } from '../src/shared/util.mjs';
import { withRemote } from './helpers.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function cliEnv(home) {
  const env = { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home, LOREKIT_HOME: home, LOREKIT_TELEMETRY: '0' };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  return env;
}

function cli(home, root) {
  const env = cliEnv(home);
  const write = (ref, value, ...extra) => spawnSync(process.execPath, [
    BIN, 'write', ref, value, ...extra, '--local', '--no-origin', '--dir', root,
  ], { encoding: 'utf8', env });
  // `show` exits 1 on a missing key; that is the answer, not a failure.
  const show = (ref) => {
    const r = spawnSync(process.execPath, [BIN, 'show', ref, '--local', '--json', '--dir', root], { encoding: 'utf8', env });
    if (r.status !== 0) return null;
    return JSON.parse(r.stdout).offline?.record ?? null;
  };
  return { write, show };
}

test('local store: --edit changes value and tags and keeps seen_count', () => {
  const home = tmp('lk-edit-home-');
  const { write, show } = cli(home, tmp('lk-edit-root-'));

  assert.equal(write('global::lesson', 'first sighting', '--tags', 'a').status, 0);
  assert.equal(write('global::lesson', 'second sighting', '--tags', 'a').status, 0);
  assert.equal(show('global::lesson').seen_count, 2);

  const edited = write('global::lesson', 'groomed body', '--tags', 'a,status::promoted', '--edit', '--json');
  assert.equal(edited.status, 0, edited.stderr);
  const out = JSON.parse(edited.stdout);
  assert.equal(out.edit, true);
  assert.equal(out.seen_count, 2);

  const record = show('global::lesson');
  assert.equal(record.seen_count, 2, 'an edit must not count a sighting');
  assert.equal(record.value, 'groomed body');
  assert.deepEqual([...record.tags].sort(), ['a', 'status::promoted']);
});

test('local store: --edit without --tags keeps the stored tags', () => {
  const home = tmp('lk-edit-home-');
  const { write, show } = cli(home, tmp('lk-edit-root-'));

  assert.equal(write('global::keep', 'v1', '--tags', 'x,y').status, 0);
  const edited = write('global::keep', 'v2', '--edit');
  assert.equal(edited.status, 0, edited.stderr);
  const record = show('global::keep');
  assert.equal(record.value, 'v2');
  assert.deepEqual([...record.tags].sort(), ['x', 'y']);
  assert.equal(record.seen_count, 1);
});

test('local store: a plain write still counts a sighting', () => {
  const home = tmp('lk-edit-home-');
  const { write, show } = cli(home, tmp('lk-edit-root-'));

  assert.equal(write('global::plain', 'one').status, 0);
  assert.equal(write('global::plain', 'one', '--edit').status, 0);
  assert.equal(write('global::plain', 'two').status, 0);
  assert.equal(show('global::plain').seen_count, 2);
});

test('local store: --edit of a missing key exits 1 and writes nothing', () => {
  const home = tmp('lk-edit-home-');
  const root = tmp('lk-edit-root-');
  const { write, show } = cli(home, root);

  const missing = write('global::nope', 'body', '--edit');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no live memory global::nope to edit/);
  assert.equal(show('global::nope'), null);
  assert.equal(fs.readdirSync(root, { recursive: true }).some((f) => String(f).endsWith('.md')), false);
});

function stubbedRemote(answer) {
  const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_rw_x' });
  const seen = [];
  store._rest = async (p, opts) => { seen.push({ path: p, ...opts }); return answer; };
  return { store, seen };
}

test('remote store: an edit sends edit: true and returns the kept seen_count', async () => {
  const { store, seen } = stubbedRemote({ ok: true, data: { version: 3, seen_count: 4, edit: true } });
  const r = await store.write({ scope: 'global', key: 'k', value: 'v', edit: true });
  assert.equal(seen[0].path, '/memories');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].body.edit, true);
  assert.equal('tags' in seen[0].body, false, 'omitted tags must stay omitted so the server keeps them');
  assert.equal(r.ok, true);
  assert.equal(r.seen_count, 4);
  assert.equal(r.edit, true);
});

test('remote store: a server that ignores edit reports edit: false', async () => {
  const { store } = stubbedRemote({ ok: true, data: { version: 2, seen_count: 2 } });
  const r = await store.write({ scope: 'global', key: 'k', value: 'v', edit: true });
  assert.equal(r.ok, true);
  assert.equal(r.edit, false);
});

test('remote store: a plain write sends no edit key', async () => {
  const { store, seen } = stubbedRemote({ ok: true, data: { version: 1, seen_count: 1 } });
  await store.write({ scope: 'global', key: 'k', value: 'v' });
  assert.equal('edit' in seen[0].body, false);
});

test('remote store: an edit of a missing key surfaces code not_found', async () => {
  const { store } = stubbedRemote({ ok: false, httpStatus: 404, error: { code: 'not_found', message: 'Memory not found' } });
  const r = await store.write({ scope: 'global', key: 'nope', value: 'v', edit: true });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.equal(r.httpStatus, 404);
});

test('remote store: lorekit write --edit exits 1 when the server does not acknowledge the edit', async () => {
  const lines = [];
  const restore = setWriters({ out: () => {}, err: (l) => lines.push(String(l)) });
  try {
    const { result, calls } = await withRemote(
      () => write({
        _: ['write', 'global::k', 'v'], edit: true, remote: true, 'no-origin': true,
        dir: tmp('lk-edit-remote-'), endpoint: 'https://ref.supabase.co/functions/v1/mcp', token: 'lk_rw_test',
      }),
      { respond: () => ({ status: 201, body: { id: 'x', scope: 'global', key: 'k', seen_count: 2, version: 2 } }) },
    );
    assert.equal(calls.find((c) => c.method === 'POST')?.body?.edit, true);
    assert.equal(typeof result === 'object' ? result.exitCode : result, 1);
    assert.match(lines.join('\n'), /does not support --edit/);
  } finally {
    restore();
  }
});

test('remote store: the stdio MCP memory.write refuses an unacknowledged edit', () => {
  const r = refuseUnacknowledgedEdit({ scope: 'global', key: 'k', edit: true }, { ok: true, edit: false, seen_count: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'edit_unsupported');
  const acked = { ok: true, edit: true };
  assert.equal(refuseUnacknowledgedEdit({ edit: true }, acked), acked);
  const plain = { ok: true };
  assert.equal(refuseUnacknowledgedEdit({}, plain), plain);
});
