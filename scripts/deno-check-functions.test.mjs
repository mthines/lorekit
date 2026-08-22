// Unit tests for the edge-typecheck ratchet's pure parts.
//
// `scripts/**` is outside the paths `nx affected` considers, so the `check` job
// never runs this file. It is executed by the `edge-typecheck` job instead —
// the same arrangement `resolve-deploy-scope.test.mjs` has with `deploy-scope`,
// and for the same reason: a test with no committed runner is not a test.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseErrorCount, compare, DENO_CHECK_FLAGS, entrypoints } from './deno-check-functions.mjs';

describe('parseErrorCount', () => {
  test('a clean run is zero', () => {
    assert.equal(parseErrorCount('Check file:///x/index.ts\n', 0), 0);
  });

  test('reads the count deno prints for a multi-error run', () => {
    assert.equal(parseErrorCount('TS2339 [ERROR]: ...\n\nFound 32 errors.\n', 1), 32);
  });

  test('a failing run with no printed count is exactly one error', () => {
    // Deno prints "Found N errors." only when N > 1, so the absence of a count
    // on a FAILING run means one — not zero, which would let a single new error
    // slip under any baseline.
    assert.equal(parseErrorCount("TS2339 [ERROR]: Property 'eq' does not exist\n", 1), 1);
    assert.equal(parseErrorCount('Found 1 error.\n', 1), 1);
  });

  test('never reports zero for a non-zero exit', () => {
    // The property that matters: exit code is authoritative about failure, the
    // count is only about magnitude. A parse that returned 0 here would make
    // the ratchet fail open on exactly the case it exists for.
    for (const output of ['', 'garbage', 'error: Type checking failed.']) {
      assert.ok(parseErrorCount(output, 1) >= 1, `"${output}" must not parse as 0`);
    }
  });
});

describe('compare', () => {
  test('equal counts are unchanged', () => {
    assert.deepEqual(compare({ mcp: 4 }, { mcp: 4 }), [{ fn: 'mcp', status: 'unchanged', now: 4, allowed: 4 }]);
  });

  test('more errors than baseline is a regression', () => {
    assert.equal(compare({ mcp: 5 }, { mcp: 4 })[0].status, 'regressed');
  });

  test('fewer errors than baseline is an improvement, not a failure', () => {
    // A ratchet that failed on improvement would punish the fix it wants.
    assert.equal(compare({ mcp: 2 }, { mcp: 4 })[0].status, 'improved');
  });

  test('zero against a zero baseline stays unchanged', () => {
    assert.equal(compare({ blog: 0 }, { blog: 0 })[0].status, 'unchanged');
  });

  test('a new function with no baseline entry is flagged, not ignored', () => {
    // Fail closed: an unlisted function would otherwise be able to carry any
    // number of errors forever.
    assert.equal(compare({ newfn: 3 }, {})[0].status, 'unlisted');
  });

  test('a baseline entry for a function that no longer exists is flagged', () => {
    // Keeps the file honest — a stale entry is dead weight that hides whether
    // the debt was fixed or the function was deleted.
    assert.equal(compare({}, { gone: 7 })[0].status, 'stale-baseline');
  });

  test('reports every function, sorted, in one pass', () => {
    const verdicts = compare({ orgs: 1, blog: 0 }, { orgs: 1, blog: 0 });
    assert.deepEqual(verdicts.map((v) => v.fn), ['blog', 'orgs']);
  });
});

describe('resolution flags', () => {
  test('both load-bearing flags are present', () => {
    // `--node-modules-dir=none` makes `npm:` resolve from Deno's cache the way
    // the deployed runtime does; `--no-lock` keeps this from creating a
    // deno.lock in a tree whose design rule is to have no Deno config.
    assert.ok(DENO_CHECK_FLAGS.includes('--node-modules-dir=none'));
    assert.ok(DENO_CHECK_FLAGS.includes('--no-lock'));
  });
});

describe('entrypoints', () => {
  test('finds every function and skips the _shared tree', () => {
    const found = entrypoints().map((e) => e.fn);
    // Anti-vacuity: a glob that matched nothing would make the whole gate pass.
    assert.ok(found.length >= 5, `expected several functions, got ${found.length}`);
    assert.ok(found.includes('mcp'));
    assert.ok(!found.some((fn) => fn.startsWith('_')), '_shared is not a function');
  });
});
