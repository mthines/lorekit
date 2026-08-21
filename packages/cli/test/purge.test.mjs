// `lorekit purge` / `purge-expired` — the guards that stand between an agent
// loop and an irreversible account-wide delete.
//
// Deliberately NO mock HTTP server. The suite's loopback-REST tests are the
// known-flaky surface in a container (the spawned child's fetch never arrives),
// and every branch worth pinning here is reachable without one: the retention
// validation, the confirmation gate and the failure rendering are pure, and the
// three refusal paths all return BEFORE any request is made — which is the
// property that matters. The one thing a fake server would add is proof that a
// URL was formed, and `remote.mjs`'s own shape is asserted directly instead.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRetentionDays,
  confirmationDecision,
  describeFailure,
  PURGE_RETENTION_DAYS_DEFAULT,
  RETENTION_DAYS_MIN,
  RETENTION_DAYS_MAX,
} from '../src/purge.mjs';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));

// Run the real binary with an isolated store. `remote` supplies a usable-LOOKING
// endpoint so the run reaches the confirmation gate: store resolution runs
// first (there is no point confirming an operation that cannot run), so a case
// that wants to prove the gate must get past it. Nothing is ever fetched — every
// assertion here is on a path that returns BEFORE the request, which is the
// property under test.
function run(args, { remote = false, ...env } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-purge-'));
  try {
    return execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
      input: '',
      env: {
        ...process.env,
        NO_COLOR: '1',
        LOREKIT_HOME: home,
        LOREKIT_STORE: fs.mkdtempSync(path.join(os.tmpdir(), 'lk-purge-s-')),
        LOREKIT_MODE: 'local',
        LOREKIT_MCP_URL: remote ? 'https://example.invalid/functions/v1/mcp' : '',
        LOREKIT_TOKEN: remote ? 'lk_rw_testtoken' : '',
        ...env,
      },
    });
  } catch (e) {
    // Non-zero exit is expected for every refusal path; return the captured
    // streams so the assertion can read the message rather than the throw.
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const streams = (res) => (typeof res === 'string' ? { status: 0, stdout: res, stderr: '' } : res);

describe('--retention-days validation happens before any request', () => {
  test('defaults to the catalog-derived window', () => {
    assert.equal(parseRetentionDays(undefined).days, PURGE_RETENTION_DAYS_DEFAULT);
    assert.equal(parseRetentionDays('').days, PURGE_RETENTION_DAYS_DEFAULT);
    // The default is DERIVED from the tool catalog, not restated here — if the
    // catalog changes it, this follows rather than contradicting the server.
    assert.equal(PURGE_RETENTION_DAYS_DEFAULT, 30);
  });

  test('accepts the inclusive boundaries', () => {
    assert.equal(parseRetentionDays(String(RETENTION_DAYS_MIN)).days, RETENTION_DAYS_MIN);
    assert.equal(parseRetentionDays(String(RETENTION_DAYS_MAX)).days, RETENTION_DAYS_MAX);
  });

  test('rejects out-of-range values on both sides', () => {
    assert.match(parseRetentionDays('0').error, /between 1 and 365/);
    assert.match(parseRetentionDays('366').error, /between 1 and 365/);
    assert.match(parseRetentionDays('400').error, /between 1 and 365/);
  });

  test('rejects a non-integer instead of coercing it', () => {
    // `Number('12abc')` is NaN and `Number('1.5')` is 1.5 — coercion would
    // either purge with a window the caller never asked for, or send a float.
    assert.match(parseRetentionDays('12abc').error, /whole number/);
    assert.match(parseRetentionDays('1.5').error, /whole number/);
    assert.match(parseRetentionDays('-3').error, /whole number/);
  });

  test('the CLI rejects it client-side, naming the range', () => {
    const res = streams(run(['purge', '--retention-days', '0', '--yes']));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /between 1 and 365/);
  });
});

describe('confirmation gate', () => {
  test('--yes proceeds', () => {
    assert.equal(confirmationDecision({ yes: true, json: false, isTTY: true }), 'proceed');
    assert.equal(confirmationDecision({ yes: true, json: true, isTTY: false }), 'proceed');
  });

  test('an interactive terminal is prompted', () => {
    assert.equal(confirmationDecision({ yes: false, json: false, isTTY: true }), 'prompt');
  });

  test('refuses when there is nobody to ask', () => {
    // The load-bearing case: an agent loop or CI job with no --yes must be
    // refused, not defaulted either way.
    assert.equal(confirmationDecision({ yes: false, json: false, isTTY: false }), 'refuse');
  });

  test('--json is non-interactive even on a TTY', () => {
    // Its caller parses stdout; a prompt would corrupt that stream.
    assert.equal(confirmationDecision({ yes: false, json: true, isTTY: true }), 'refuse');
  });

  test('the CLI refuses without --yes and says how to confirm', () => {
    const res = streams(run(['purge'], { remote: true }));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Refusing/);
    assert.match(res.stderr, /cannot be undone/);
    assert.match(res.stderr, /--yes/);
  });

  test('purge-expired refuses on the same terms', () => {
    const res = streams(run(['purge-expired'], { remote: true }));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Refusing/);
    assert.match(res.stderr, /--yes/);
  });
});

describe('--local is refused, not silently ignored', () => {
  test('names the reason and exits non-zero', () => {
    const res = streams(run(['purge', '--local', '--yes']));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /remote maintenance operation/);
    // A no-op "success" would be the dangerous outcome: the caller would
    // believe a purge happened against a store that cannot perform one.
    assert.doesNotMatch(res.stdout, /purged/);
  });
});

describe('failure rendering', () => {
  test('a 403 prints the server sentence verbatim plus a next step', () => {
    const serverSentence =
      '"memory.purge" operates across your whole account, so it is not available to a '
      + 'token restricted to specific scopes. Use an unscoped token for maintenance sweeps.';
    const { message, hint } = describeFailure({
      httpStatus: 403,
      error: { code: 'permission_denied', message: serverSentence },
    });
    // Verbatim: the server's explanation is better than any translation, and
    // collapsing it into "purge failed" is what leaves someone re-running the
    // same command with the same key.
    assert.equal(message, serverSentence);
    assert.match(hint, /UNSCOPED/);
  });

  test('a 429 is reported as rate limiting, not a permission problem', () => {
    const { message, hint } = describeFailure({
      httpStatus: 429,
      error: { message: 'rate limit exceeded' },
    });
    assert.match(message, /rate limit/);
    assert.match(hint, /Rate limited/);
  });

  test('a network failure reports the transport error and adds no hint', () => {
    const { message, hint } = describeFailure({ networkError: 'fetch failed' });
    assert.equal(message, 'fetch failed');
    assert.equal(hint, null);
  });

  test('an error with no status still yields a message', () => {
    assert.equal(typeof describeFailure({ error: 'boom' }).message, 'string');
    assert.equal(typeof describeFailure({}).message, 'string');
  });
});

describe('the remote store speaks the documented REST contract', () => {
  // Asserted against the module's own shape rather than a mock server: what
  // matters is the path, the method and the body key the handler validates
  // (`retention_days`, snake_case, per PurgeMemoriesBodySchema).
  test('purge posts to /memories/purge and purge-expired to /memories/purge-expired', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../src/store/remote.mjs', import.meta.url)),
      'utf8',
    );
    assert.match(source, /'\/memories\/purge',\s*\{\s*method:\s*'POST'/);
    assert.match(source, /'\/memories\/purge-expired',\s*\{\s*method:\s*'POST'/);
    assert.match(source, /body: \{ retention_days: retentionDays \}/);
  });

  test('purge always sends an explicit retention window', async () => {
    // Never left to the server's default: an irreversible sweep should record
    // the window it used, and the CLI has to know the number anyway because its
    // confirmation prompt names what is about to be deleted.
    const { createRemoteStore } = await import('../src/store/remote.mjs');
    const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_rw_x' });
    const seen = [];
    store._rest = async (p, opts) => { seen.push({ p, opts }); return { ok: true, data: { purged: 3 } }; };

    const res = await store.purge({ retentionDays: PURGE_RETENTION_DAYS_DEFAULT });
    assert.equal(res.ok, true);
    assert.equal(res.purged, 3);
    assert.deepEqual(seen[0].opts.body, { retention_days: PURGE_RETENTION_DAYS_DEFAULT });

    await store.purge({ retentionDays: 90 });
    assert.deepEqual(seen[1].opts.body, { retention_days: 90 });
  });

  test('purge refuses an absent or non-integer window instead of defaulting', async () => {
    // The failure mode this replaces: `{ retention_days: undefined }` is dropped
    // by JSON.stringify, so a caller that forgot the window would silently
    // hard-delete against the SERVER's default — a window nobody chose, on an
    // irreversible account-wide sweep. Throwing names the mistake at the call
    // site. Unreachable through the CLI (parseRetentionDays resolves first), so
    // this pins the contract for the next caller.
    const { createRemoteStore } = await import('../src/store/remote.mjs');
    const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_rw_x' });
    let called = false;
    store._rest = async () => { called = true; return { ok: true, data: { purged: 0 } }; };

    for (const bad of [undefined, null, '30', 1.5, NaN]) {
      await assert.rejects(
        () => store.purge({ retentionDays: bad }),
        /explicit integer retentionDays/,
        `retentionDays=${JSON.stringify(bad)} must be refused`,
      );
    }
    // No-argument call: the `= {}` default makes this a clean refusal rather
    // than a destructuring TypeError.
    await assert.rejects(() => store.purge(), /explicit integer retentionDays/);

    assert.equal(called, false, 'a refused purge must not reach the network');
  });

  test('purge-expired sends no body at all', async () => {
    // The asymmetry is real and worth pinning: `purge-expired` has no window to
    // name — the row set is every expired memory the caller owns.
    const { createRemoteStore } = await import('../src/store/remote.mjs');
    const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_rw_x' });
    let seen;
    store._rest = async (p, opts) => { seen = { p, opts }; return { ok: true, data: { purged: 0 } }; };

    await store.purgeExpired();
    assert.equal(seen.p, '/memories/purge-expired');
    assert.equal(seen.opts.body, undefined);
  });

  test('a failed purge carries httpStatus through for the 403 message', async () => {
    const { createRemoteStore } = await import('../src/store/remote.mjs');
    const store = createRemoteStore({ endpoint: 'https://example.test/functions/v1/mcp', token: 'lk_rw_x' });
    store._rest = async () => ({ ok: false, httpStatus: 403, error: { message: 'refused' } });

    const res = await store.purge({ retentionDays: 30 });
    assert.equal(res.ok, false);
    assert.equal(res.httpStatus, 403, 'httpStatus is the ONLY place the real status lives');
    assert.equal(res.purged, null);
  });
});
