// `lorekit quota` — the CLI face of GET /memories/quota. Remote-only, and the
// one read command that exits 1 when the remote cannot answer, because there
// is no offline answer to fall back to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lorekit.mjs', import.meta.url));
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const QUOTA = {
  plan: 'free',
  personal: { count: 4600, limit: 5000, remaining: 400 },
  org_count: 982,
  total: 5582,
};

function baseEnv(home, extraEnv = {}) {
  const env = {
    ...process.env,
    NO_COLOR: '1',
    HOME: home,
    USERPROFILE: home,
    LOREKIT_HOME: home,
    LOREKIT_TELEMETRY: '0',
  };
  delete env.LOREKIT_TOKEN;
  delete env.LOREKIT_MCP_URL;
  delete env.LOREKIT_ENDPOINT;
  return Object.assign(env, extraEnv);
}

function runQuotaAsync(args, extraEnv) {
  const root = tmp('lk-quota-root-');
  const home = tmp('lk-quota-home-');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'quota', ...args, '--dir', root], {
      env: baseEnv(home, extraEnv),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// `LOREKIT_MCP_URL` points at `/mcp`, from which the REST base is derived, so
// the command lands on `GET /memories/quota`.
async function withMockRemote(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    return await fn({
      seen,
      env: { LOREKIT_MCP_URL: `http://127.0.0.1:${port}/mcp`, LOREKIT_TOKEN: 'lk_ro_test' },
    });
  } finally {
    server.close();
  }
}

const answerWith = (body, status = 200) => (_req, res) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

test('quota --json reports the remote quota from GET /memories/quota', async () => {
  await withMockRemote(answerWith(QUOTA), async ({ seen, env }) => {
    const res = await runQuotaAsync(['--json'], env);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(seen.some((r) => /^GET \/+memories\/quota$/.test(r)), `requests seen: ${seen.join(', ')}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.available, true);
    assert.deepEqual(
      { plan: out.plan, personal: out.personal, org_count: out.org_count, total: out.total },
      QUOTA,
    );
  });
});

test('quota prints the personal pair, the org count beside it, and warns near the cap', async () => {
  await withMockRemote(answerWith(QUOTA), async ({ env }) => {
    const res = await runQuotaAsync([], env);
    assert.equal(res.status, 0, res.stderr);
    const text = res.stdout + res.stderr;
    assert.match(text, /4600 \/ 5000/);
    assert.match(text, /400 left/);
    assert.match(text, /982/);
    assert.match(text, /near the cap/);
  });
});

test('quota exits 1 with an accurate note when the remote fails', async () => {
  await withMockRemote(answerWith({ error: 'kaboom' }, 500), async ({ env }) => {
    const res = await runQuotaAsync(['--json'], env);
    assert.equal(res.status, 1);
    const out = JSON.parse(res.stdout);
    assert.equal(out.available, false);
    assert.match(out.reason, /500|kaboom/);
  });
});

test('quota exits 1 when no remote is configured', () => {
  const root = tmp('lk-quota-root-');
  const home = tmp('lk-quota-home-');
  const res = spawnSync(process.execPath, [BIN, 'quota', '--json', '--dir', root], {
    encoding: 'utf8',
    env: baseEnv(home),
  });
  assert.equal(res.status, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.available, false);
  assert.match(out.reason, /endpoint|token/);
});
