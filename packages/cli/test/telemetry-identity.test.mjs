// Tests for the durable CLI telemetry identity: minting and persistence, the
// privacy invariants that constrain when anything is written at all, the
// attribute shapes, and the two integration seams (the OTLP payloads carry the
// identity; the metric-only `meterCommand` path passes exit codes through).
//
// Everything here drives the module through an explicit `file` path under a
// temp dir. No mock HTTP server: the loopback-fetch tests in this package are
// the ones that are red on a clean tree, and identity needs no network at all —
// see the sandbox notes in CLAUDE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  identityPath,
  readIdentity,
  ensureIdentity,
  ensureInstallId,
  rememberAccountId,
  mintInstallId,
  identityAttributes,
  identityResourceAttributes,
  describeIdentity,
} from '../src/telemetry/telemetry-identity.mjs';
import {
  buildTracePayload,
  buildMetricsPayload,
  meterCommand,
} from '../src/telemetry/telemetry.mjs';

const ON = { enabled: true };
const OFF = { enabled: false };

let counter = 0;
/** A fresh temp identity-file path that does not exist yet. */
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorekit-id-'));
  return path.join(dir, `sub-${counter++}`, 'telemetry-id.json');
}

/** Read an attribute's stringValue out of an OTLP key/value list. */
function attr(list, key) {
  return list.find((a) => a.key === key)?.value?.stringValue;
}

// ── minting & persistence ─────────────────────────────────────────────────────

test('ensureIdentity mints an install id once and reuses it', () => {
  const file = tmpFile();
  const first = ensureIdentity(ON, { file });
  assert.match(first.installId, /^[0-9a-f]{32}$/);
  assert.equal(first.accountId, null);
  // Same file → same id. This is the whole point: two runs are correlatable.
  assert.equal(ensureIdentity(ON, { file }).installId, first.installId);
  assert.equal(ensureIdentity(ON, { file }).installId, first.installId);
});

test('mintInstallId produces distinct opaque ids, not a machine fingerprint', () => {
  const ids = new Set(Array.from({ length: 50 }, mintInstallId));
  assert.equal(ids.size, 50, 'minted ids must not collide');
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
  // Nothing derived from the machine may leak in — the id is resettable only
  // because it is random. A hostname/user-derived id would survive deletion.
  const hay = [...ids].join(' ');
  for (const leak of [os.hostname(), os.userInfo().username, os.homedir()]) {
    if (leak) assert.ok(!hay.includes(leak), `minted id must not embed ${leak}`);
  }
});

test('ensureInstallId delegates to ensureIdentity (one mint implementation)', () => {
  const file = tmpFile();
  const viaNarrow = ensureInstallId(ON, { file });
  assert.match(viaNarrow, /^[0-9a-f]{32}$/);
  assert.equal(ensureIdentity(ON, { file }).installId, viaNarrow);
});

// ── privacy invariants ────────────────────────────────────────────────────────

test('a disabled config mints nothing and creates NO file', () => {
  const file = tmpFile();
  assert.deepEqual(ensureIdentity(OFF, { file }), { installId: null, accountId: null });
  assert.equal(ensureInstallId(OFF, { file }), null);
  // The invariant that matters: an opted-out user gets no tracking id written
  // to their disk, not merely an unreported one.
  assert.equal(fs.existsSync(file), false, 'opted out must leave no file behind');
  assert.equal(fs.existsSync(path.dirname(file)), false, 'not even the directory');
});

test('a missing/undefined config is treated as disabled', () => {
  const file = tmpFile();
  for (const bad of [undefined, null, {}, { enabled: 'yes' }, { enabled: 1 }]) {
    assert.equal(ensureIdentity(bad, { file }).installId, null);
  }
  assert.equal(fs.existsSync(file), false);
});

test('rememberAccountId NEVER creates the identity file', () => {
  const file = tmpFile();
  // This is what keeps an opted-out user's account id off their disk: they
  // still RECEIVE the X-LoreKit-User-Id header on every authenticated call, so
  // the only thing stopping it being recorded is this refusal to create a file.
  assert.equal(rememberAccountId('acct-1', { file }), false);
  assert.equal(fs.existsSync(file), false);
});

test('an account id alone is never emitted as an identity', () => {
  // Defence in depth for the invariant above: even if a file somehow held only
  // an accountId, there is no install id, so there is no identity to report.
  assert.deepEqual(identityAttributes({ accountId: 'acct-1' }), {});
  assert.deepEqual(identityResourceAttributes({ accountId: 'acct-1' }), {});
});

// ── account linkage ───────────────────────────────────────────────────────────

test('rememberAccountId records, then no-ops on an unchanged value', () => {
  const file = tmpFile();
  ensureIdentity(ON, { file });
  assert.equal(rememberAccountId('acct-1', { file }), true);
  assert.equal(readIdentity(file).accountId, 'acct-1');
  // Idempotent — the common case is a read and no write.
  assert.equal(rememberAccountId('acct-1', { file }), false);
  // A different account (a token swap) replaces it.
  assert.equal(rememberAccountId('acct-2', { file }), true);
  assert.equal(readIdentity(file).accountId, 'acct-2');
});

test('rememberAccountId ignores non-string and empty values', () => {
  const file = tmpFile();
  ensureIdentity(ON, { file });
  for (const bad of [undefined, null, '', 0, {}, []]) {
    assert.equal(rememberAccountId(bad, { file }), false);
  }
  assert.equal(readIdentity(file).accountId, undefined);
});

test('linking an account preserves the install id', () => {
  const file = tmpFile();
  const { installId } = ensureIdentity(ON, { file });
  rememberAccountId('acct-1', { file });
  const after = ensureIdentity(ON, { file });
  // `service.instance.id` must be stable across a sign-in, or one install
  // would look like two.
  assert.equal(after.installId, installId);
  assert.equal(after.accountId, 'acct-1');
});

// ── totality: nothing here may throw ──────────────────────────────────────────

test('readIdentity is total over a missing, corrupt, or wrong-typed file', () => {
  const file = tmpFile();
  assert.deepEqual(readIdentity(file), {}, 'missing file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const body of ['', '{', 'null', '42', '"str"', '[]', '[1,2]']) {
    fs.writeFileSync(file, body);
    assert.deepEqual(readIdentity(file), {}, `body ${JSON.stringify(body)}`);
  }
  // Valid JSON object, but the fields are the wrong type. Emitting these would
  // ship `[object Object]` as an identity and fold every such install into one.
  fs.writeFileSync(file, JSON.stringify({ installId: {}, accountId: 7 }));
  assert.deepEqual(readIdentity(file), {});
});

test('a corrupt file is repaired with a fresh install id', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json at all');
  const { installId } = ensureIdentity(ON, { file });
  assert.match(installId, /^[0-9a-f]{32}$/);
});

test('a file with an accountId but no installId keeps the account on repair', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ accountId: 'acct-9' }));
  const got = ensureIdentity(ON, { file });
  assert.match(got.installId, /^[0-9a-f]{32}$/);
  assert.equal(got.accountId, 'acct-9', 'repairing the install id must not drop the linkage');
});

test('an unpersistable id reports NO identity, not a fresh one per run', () => {
  // A per-run id would inflate the distinct-install count to equal the
  // invocation count — indistinguishable, in the data, from that many real
  // installs. Reporting nothing is the honest answer.
  //
  // The failure is forced by making the parent path a FILE, so `mkdirSync`
  // fails with ENOTDIR. Deliberately not `chmod 0o500`: the test suite runs as
  // root in CI containers, where mode bits do not deny the owner and the write
  // would succeed — the assertion would then pass for the wrong reason on a
  // developer machine and silently prove nothing in CI.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorekit-id-ro-'));
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  const file = path.join(blocker, 'telemetry-id.json');
  assert.deepEqual(ensureIdentity(ON, { file }), { installId: null, accountId: null });
  // And the narrow accessor agrees, rather than reporting a value it failed to store.
  assert.equal(ensureInstallId(ON, { file }), null);
});

// ── attribute shapes ──────────────────────────────────────────────────────────

test('identityAttributes: no identity, install-only, then account', () => {
  assert.deepEqual(identityAttributes({}), {});
  assert.deepEqual(identityAttributes(), {});
  // Pre-auth: prefixed, so it can never be mistaken for a real account id.
  assert.deepEqual(identityAttributes({ installId: 'abc' }), { 'user.id': 'install:abc' });
  // Once linked, `user.id` IS the account — that is what collapses one person's
  // laptop and CI runs into one user.
  assert.deepEqual(
    identityAttributes({ installId: 'abc', accountId: 'acct-1' }),
    { 'user.id': 'acct-1' },
  );
});

test('identityResourceAttributes uses the semconv service.instance.id', () => {
  assert.deepEqual(identityResourceAttributes({}), {});
  assert.deepEqual(identityResourceAttributes({ installId: 'abc' }), { 'service.instance.id': 'abc' });
  // The install id stays on the resource even once an account is known, so
  // installs remain distinguishable underneath the user rollup.
  assert.deepEqual(
    identityResourceAttributes({ installId: 'abc', accountId: 'acct-1' }),
    { 'service.instance.id': 'abc' },
  );
});

test('identityPath follows LOREKIT_HOME, and describeIdentity never mints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorekit-id-home-'));
  assert.equal(identityPath({ LOREKIT_HOME: dir }), path.join(dir, 'telemetry-id.json'));

  const file = tmpFile();
  const described = describeIdentity({ file });
  assert.deepEqual(described, { file, installId: null, accountId: null });
  assert.equal(fs.existsSync(file), false, 'describeIdentity must not create the file');

  ensureIdentity(ON, { file });
  rememberAccountId('acct-1', { file });
  const after = describeIdentity({ file });
  assert.match(after.installId, /^[0-9a-f]{32}$/);
  assert.equal(after.accountId, 'acct-1');
});

// ── OTLP payload integration ──────────────────────────────────────────────────

test('the OTLP payloads carry service.instance.id, and omit it without identity', () => {
  const base = { version: '1.2.3', name: 'lorekit.cli.list', attributes: {}, startMs: 1, endMs: 2, status: 'ok' };

  const withId = buildTracePayload({ ...base, identity: { installId: 'inst-1' } });
  const traceRes = withId.resourceSpans[0].resource.attributes;
  assert.equal(attr(traceRes, 'service.instance.id'), 'inst-1');
  assert.equal(attr(traceRes, 'service.name'), 'cli');

  const metricRes = buildMetricsPayload({ ...base, identity: { installId: 'inst-1' } })
    .resourceMetrics[0].resource.attributes;
  assert.equal(attr(metricRes, 'service.instance.id'), 'inst-1');

  // Omitted, never placeholdered: a constant stand-in would fold every
  // opted-out or unwritable-home machine into one instance.
  for (const identity of [undefined, {}, { installId: null }]) {
    const res = buildTracePayload({ ...base, identity }).resourceSpans[0].resource.attributes;
    assert.equal(res.find((a) => a.key === 'service.instance.id'), undefined);
  }
});

// ── the metric-only machine-facing path ───────────────────────────────────────

test('meterCommand passes the exit code through and never exports when disabled', async () => {
  // Export off (no endpoint, no credential) is the overwhelmingly common case
  // for `hook`/`mcp`, and must cost nothing — including no identity file.
  const prev = process.env.LOREKIT_TELEMETRY;
  process.env.LOREKIT_TELEMETRY = '0';
  try {
    assert.equal(await meterCommand('hook', '1.0.0', () => 0), 0);
    assert.equal(await meterCommand('hook', '1.0.0', () => 3), 3);
    // The `{ exitCode, ...extra }` object shape commands may return is
    // normalized here too — returning the raw object would reach process.exit()
    // and crash with ERR_INVALID_ARG_TYPE.
    assert.equal(await meterCommand('mcp', '1.0.0', () => ({ exitCode: 2, foo: 'bar' })), 2);
    assert.equal(await meterCommand('hook', '1.0.0', () => undefined), 0);
  } finally {
    if (prev === undefined) delete process.env.LOREKIT_TELEMETRY;
    else process.env.LOREKIT_TELEMETRY = prev;
  }
});

test('meterCommand propagates a thrown command error unchanged', async () => {
  const prev = process.env.LOREKIT_TELEMETRY;
  process.env.LOREKIT_TELEMETRY = '0';
  try {
    await assert.rejects(
      () => meterCommand('hook', '1.0.0', () => { throw new Error('boom'); }),
      /boom/,
    );
  } finally {
    if (prev === undefined) delete process.env.LOREKIT_TELEMETRY;
    else process.env.LOREKIT_TELEMETRY = prev;
  }
});

/**
 * Run `body` with export ENABLED (a non-default OTLP endpoint enables without a
 * token) and `global.fetch` captured, so the metrics POST can be inspected
 * without a real collector. LOREKIT_HOME is redirected to a throwaway dir so the
 * identity resolution the enabled path performs never touches the real store.
 */
async function withEnabledExport(body) {
  const prev = {
    LOREKIT_TELEMETRY: process.env.LOREKIT_TELEMETRY,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    LOREKIT_HOME: process.env.LOREKIT_HOME,
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, async text() { return '{}'; } };
  };
  delete process.env.LOREKIT_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://otel.example.com';
  process.env.LOREKIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lorekit-meter-'));
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The single metrics datapoint's attributes, as a plain key→value map. */
function metricAttrs(call) {
  const dp = call.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0];
  return Object.fromEntries(
    dp.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.boolValue ?? a.value.intValue]),
  );
}

test('meterCommand exports on the enabled HOOK path, and the hook meter attrs reach the counter', async () => {
  // The hook branch counts AFTER run and threads the result's `meter` object
  // into countInvocation as extra dimensions. Assert both that the enabled path
  // fires a metrics POST and that hookMeterAttrs' output (lorekit.hook.outcome
  // + lorekit.hook.event) actually lands on the datapoint — the path this PR
  // added and that only the disabled cases covered.
  await withEnabledExport(async (calls) => {
    const code = await meterCommand('hook', '1.0.0', () => ({
      exitCode: 0,
      meter: { 'lorekit.hook.outcome': 'ok', 'lorekit.hook.event': 'SessionStart' },
    }));
    assert.equal(code, 0);
    const metrics = calls.find((c) => c.url.endsWith('/v1/metrics'));
    assert.ok(metrics, 'the enabled hook path must POST a metric');
    const attrs = metricAttrs(metrics);
    assert.equal(attrs['lorekit.cli.command'], 'hook');
    assert.equal(attrs['lorekit.hook.outcome'], 'ok');
    assert.equal(attrs['lorekit.hook.event'], 'SessionStart');
  });
});

test('meterCommand exports on the enabled MCP path and passes the exit code through', async () => {
  // The mcp branch counts BEFORE run (long-lived server) and awaits the pending
  // count in `finally`. Assert the enabled path fires the metrics POST and the
  // exit code is still returned unchanged.
  await withEnabledExport(async (calls) => {
    const code = await meterCommand('mcp', '1.0.0', () => ({ exitCode: 2, foo: 'bar' }));
    assert.equal(code, 2);
    const metrics = calls.find((c) => c.url.endsWith('/v1/metrics'));
    assert.ok(metrics, 'the enabled mcp path must POST a metric');
    assert.equal(metricAttrs(metrics)['lorekit.cli.command'], 'mcp');
  });
});
