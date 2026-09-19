// `lorekit policy <list|create|update|delete>` — dimension-filter flags.
//
// Exercises the command through a REAL RemoteStore over a stubbed `fetch`
// (see `withRemote` in helpers.mjs) rather than a hand-written store double,
// so the assertions are on what actually lands ON THE WIRE — the contract
// AC-5 cares about — and cannot silently drift from the request body the
// server receives.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { policy } from '../src/commands/policy.mjs';
import { parseDimensionConditions } from '../src/shared/flags.mjs';
import { setWriters } from '../src/shared/util.mjs';
import { withRemote } from './helpers.mjs';

const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-policy-'));
}

// Silence the command's own stdout/stderr (setWriters is the CLI's own
// redirect seam — see purge.test.mjs / migrate.test.mjs for why `process.
// stdout.write` is never hijacked directly: this suite runs inside
// `node --test`, which reports over stdout, so a global hijack would swallow
// the runner's own result lines).
async function quiet(fn) {
  const restore = setWriters({ out: () => {}, err: () => {} });
  try {
    return await fn();
  } finally {
    restore();
  }
}

function baseArgs(extra = {}) {
  return { _: ['policy'], dir: tmpDir(), endpoint: ENDPOINT, token: TOKEN, json: true, ...extra };
}

describe('parseDimensionConditions', () => {
  test('parses comma-separated values and rejects an invalid mode', () => {
    const ok = parseDimensionConditions({ kind: 'bus,lesson', 'kind-mode': 'in' });
    assert.deepEqual(ok.conditions, { kind: ['bus', 'lesson'], kind_mode: 'in' });

    const bad = parseDimensionConditions({ 'kind-mode': 'nope' });
    assert.match(bad.error, /--kind-mode must be one of in\|nin/);
  });

  test('tags-mode accepts any/all/none, not in/nin', () => {
    const ok = parseDimensionConditions({ tags: 'a,b', 'tags-mode': 'all' });
    assert.deepEqual(ok.conditions, { tags: ['a', 'b'], tags_mode: 'all' });

    const bad = parseDimensionConditions({ 'tags-mode': 'in' });
    assert.match(bad.error, /--tags-mode must be one of any\|all\|none/);
  });

  test('omits a dimension entirely when neither its value nor its mode flag was passed', () => {
    const { conditions } = parseDimensionConditions({ scope: 'global' });
    assert.deepEqual(conditions, {});
  });

  test('clearable: true sends explicit null for --clear-<dim> and ignores a same-dimension value flag', () => {
    const { conditions } = parseDimensionConditions(
      { 'clear-kind': true, kind: 'bus', host: 'reviewer,aw' },
      { clearable: true },
    );
    assert.deepEqual(conditions, { kind: null, host: ['reviewer', 'aw'] });
  });

  test('clearable: false ignores a clear-* flag (create has no clear semantics)', () => {
    const { conditions } = parseDimensionConditions({ 'clear-kind': true, kind: 'bus' }, { clearable: false });
    assert.deepEqual(conditions, { kind: ['bus'] });
  });
});

describe('policy create — dimension filters over the wire', () => {
  test('builds the full dimension payload and is accepted', async () => {
    const { result, calls } = await withRemote(
      () =>
        quiet(() =>
          policy(
            baseArgs({
              _: ['policy', 'create'],
              scope: 'global',
              name: 'n',
              kind: 'bus',
              'kind-mode': 'in',
              tags: 'ci::pr-review-state',
              'tags-mode': 'all',
            }),
          ),
        ),
      { respond: (call) => (call.method === 'POST' ? { status: 201, body: { id: 'p1', ...call.body } } : null) },
    );
    assert.equal(result, 0);
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/memories/policies'));
    assert.ok(create, 'expected a POST /memories/policies call');
    assert.equal(create.body.kind_mode, 'in');
    assert.deepEqual(create.body.kind, ['bus']);
    assert.equal(create.body.tags_mode, 'all');
    assert.deepEqual(create.body.tags, ['ci::pr-review-state']);
  });

  test('rejects an invalid --<dim>-mode before making any request', async () => {
    const { result, calls } = await withRemote(() =>
      quiet(() => policy(baseArgs({ _: ['policy', 'create'], scope: 'global', name: 'n', 'kind-mode': 'nope' }))),
    );
    assert.equal(result, 1);
    assert.equal(calls.length, 0);
  });
});

describe('policy update — clear-* and dimension patch over the wire', () => {
  test('--clear-kind --host reviewer,aw sends kind:null, host:[...]', async () => {
    const { result, calls } = await withRemote(
      () =>
        quiet(() =>
          policy(baseArgs({ _: ['policy', 'update', 'p1'], 'clear-kind': true, host: 'reviewer,aw' })),
        ),
      {
        respond: (call) =>
          call.method === 'PATCH' ? { status: 200, body: { id: 'p1', name: 'n', scope: 'global', ...call.body } } : null,
      },
    );
    assert.equal(result, 0);
    const update = calls.find((c) => c.method === 'PATCH');
    assert.ok(update, 'expected a PATCH /memories/policies/:id call');
    assert.equal(update.body.kind, null);
    assert.deepEqual(update.body.host, ['reviewer', 'aw']);
    // The clear is on kind alone — kind_mode is untouched by the clear, and
    // not named at all here, so it must not appear in the patch body.
    assert.equal('kind_mode' in update.body, false);
  });
});
