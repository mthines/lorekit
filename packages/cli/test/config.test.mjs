// Regression tests for the .mcp.json read paths and copyDir accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readMcpConfig,
  readLorekitServer,
  readJsonIfExists,
  copyDir,
  mcpJsonPath,
  onPath,
  resolveHookRunner,
  writeFileAtomic,
} from '../src/config.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-cfg-'));
}

// Regression: `npx @lorekit/cli install` stages a `lorekit` symlink into an
// ephemeral …/_npx/<hash>/node_modules/.bin dir and prepends it to PATH. That
// dir must NOT count as a durable install, or hooks get wired as bare
// `lorekit hook …` and fail with `command not found` once npx exits.
test('onPath ignores npx ephemeral bin dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-npx-'));
  const npxBin = path.join(root, '_npx', 'abc123', 'node_modules', '.bin');
  fs.mkdirSync(npxBin, { recursive: true });
  fs.writeFileSync(path.join(npxBin, 'lorekit'), '#!/bin/sh\n');

  const savedPath = process.env.PATH;
  try {
    process.env.PATH = npxBin; // only the ephemeral dir is on PATH
    assert.equal(onPath('lorekit'), false, 'ephemeral npx dir must not count as installed');
    assert.equal(resolveHookRunner(), 'npx -y @lorekit/cli');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('onPath honours a durable global install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-bin-'));
  fs.writeFileSync(path.join(dir, 'lorekit'), '#!/bin/sh\n');

  const savedPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    assert.equal(onPath('lorekit'), true);
    assert.equal(resolveHookRunner(), 'lorekit');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('readMcpConfig distinguishes absent / valid / invalid', () => {
  const root = tmpRoot();
  assert.deepEqual(readMcpConfig(root), { present: false, valid: false, config: null });

  fs.writeFileSync(mcpJsonPath(root), '{ this is not json ');
  const bad = readMcpConfig(root);
  assert.equal(bad.present, true);
  assert.equal(bad.valid, false);

  fs.writeFileSync(mcpJsonPath(root), JSON.stringify({ mcpServers: {} }));
  const ok = readMcpConfig(root);
  assert.equal(ok.valid, true);
  assert.ok(ok.config.mcpServers);
});

test('readLorekitServer never throws on a malformed .mcp.json', () => {
  const root = tmpRoot();
  fs.writeFileSync(mcpJsonPath(root), '{ broken');
  assert.doesNotThrow(() => readLorekitServer(root));
  assert.equal(readLorekitServer(root), null); // degrades to "no server"
});

test('readJsonIfExists still throws on malformed JSON (install clobber-guard)', () => {
  const root = tmpRoot();
  fs.writeFileSync(mcpJsonPath(root), '{ broken');
  assert.throws(() => readJsonIfExists(mcpJsonPath(root)), /Failed to parse/);
});

test('writeFileAtomic replaces content, preserves perms, and leaves no temp file', () => {
  const root = tmpRoot();
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, 'old');
  fs.chmodSync(file, 0o600); // a locked-down config holding secrets

  writeFileAtomic(file, 'new-content');

  assert.equal(fs.readFileSync(file, 'utf8'), 'new-content', 'content replaced');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'original 0600 perms preserved on replace');
  assert.deepEqual(
    fs.readdirSync(root).filter((f) => f.includes('.tmp')),
    [],
    'no leftover temp file',
  );
});

test('writeFileAtomic creates a new file (and its parent dir) when absent', () => {
  const root = tmpRoot();
  const file = path.join(root, 'nested', 'dir', '.mcp.json');
  writeFileAtomic(file, 'fresh');
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh');
});

test('copyDir reports how many files it actually wrote', () => {
  const src = tmpRoot();
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'a.txt'), 'a');
  fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'b');
  const dest = path.join(tmpRoot(), 'out');

  assert.equal(copyDir(src, dest), 2); // fresh install: both files written
  assert.equal(copyDir(src, dest), 0); // re-run without --force: nothing written
  assert.equal(copyDir(src, dest, { force: true }), 2); // force: both rewritten
});

// ── mcp.endpoint in .lorekit.json ─────────────────────────────────────────────
import { resolveProjectConnection } from '../src/config.mjs';
import { splitEndpoint } from '../src/mcp.mjs';

test('resolveProjectConnection uses mcp.endpoint from .lorekit.json as fallback', () => {
  const root = tmpRoot();
  const ep = 'https://abc.supabase.co/functions/v1/mcp';
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'mcp.endpoint': ep }));
  const conn = resolveProjectConnection(root, splitEndpoint);
  assert.equal(conn.endpoint, ep);
});

test('resolveProjectConnection prefers .mcp.json over mcp.endpoint in .lorekit.json', () => {
  const root = tmpRoot();
  const mpcEp = 'https://primary.supabase.co/functions/v1/mcp';
  const fallbackEp = 'https://fallback.supabase.co/functions/v1/mcp';
  const mcpJson = {
    mcpServers: {
      lorekit: {
        command: 'npx',
        args: ['-y', 'mcp-remote', mpcEp, '--header', 'Authorization:Bearer lk_rw_tok'],
      },
    },
  };
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify(mcpJson));
  fs.writeFileSync(path.join(root, '.lorekit.json'), JSON.stringify({ 'mcp.endpoint': fallbackEp }));
  const conn = resolveProjectConnection(root, splitEndpoint);
  assert.equal(conn.endpoint, mpcEp);
});

test('resolveProjectConnection ignores placeholder mcp.endpoint', () => {
  const root = tmpRoot();
  fs.writeFileSync(
    path.join(root, '.lorekit.json'),
    JSON.stringify({ 'mcp.endpoint': 'https://<project-ref>.supabase.co/functions/v1/mcp' }),
  );
  const conn = resolveProjectConnection(root, splitEndpoint);
  assert.equal(conn.endpoint, null);
});
