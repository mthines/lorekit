// `lorekit groom` — dimension-filter flags on the inline (--scope) path, and
// the `--policy-id` mutual-exclusion with inline conditions.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { groom, parseGroomRequest } from '../src/commands/groom.mjs';
import { setWriters } from '../src/shared/util.mjs';
import { withRemote } from './helpers.mjs';

const ENDPOINT = 'https://ref.supabase.co/functions/v1/mcp';
const TOKEN = 'lk_rw_test';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-groom-'));
}

async function quiet(fn) {
  const restore = setWriters({ out: () => {}, err: () => {} });
  try {
    return await fn();
  } finally {
    restore();
  }
}

describe('parseGroomRequest — dimension conditions', () => {
  test('merges dimension conditions into an inline (--scope) request', () => {
    const { request } = parseGroomRequest({ scope: 'global', kind: 'bus', tags: 'x', 'tags-mode': 'all' });
    assert.equal(request.scope, 'global');
    assert.deepEqual(request.kind, ['bus']);
    assert.deepEqual(request.tags, ['x']);
    assert.equal(request.tags_mode, 'all');
  });

  test('--policy-id ignores inline dimension flags rather than merging them', () => {
    const { request } = parseGroomRequest({ 'policy-id': 'p1', kind: 'bus' });
    assert.deepEqual(request, { policy_id: 'p1' });
  });

  test('--policy-id and --scope stay mutually exclusive', () => {
    const { error } = parseGroomRequest({ 'policy-id': 'p1', scope: 'global' });
    assert.match(error, /mutually exclusive/);
  });

  test('an invalid --<dim>-mode is rejected before building the request', () => {
    const { error } = parseGroomRequest({ scope: 'global', 'kind-mode': 'nope' });
    assert.match(error, /--kind-mode must be one of in\|nin/);
  });
});

describe('groom — dimension filters over the wire', () => {
  test('forwards dimension conditions in the groom.preview body', async () => {
    const { result, calls } = await withRemote(
      () =>
        quiet(() =>
          groom({
            _: ['groom'],
            dir: tmpDir(),
            endpoint: ENDPOINT,
            token: TOKEN,
            json: true,
            scope: 'global',
            kind: 'bus',
            tags: 'x',
            'tags-mode': 'all',
          }),
        ),
      { respond: () => ({ status: 200, body: { count: 0, keys: [] } }) },
    );
    assert.equal(result, 0);
    const preview = calls.find((c) => c.url.endsWith('/memories/groom/preview'));
    assert.ok(preview, 'expected a POST /memories/groom/preview call');
    assert.deepEqual(preview.body.kind, ['bus']);
    assert.deepEqual(preview.body.tags, ['x']);
    assert.equal(preview.body.tags_mode, 'all');
  });
});
