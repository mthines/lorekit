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
} from '../src/config.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lk-cfg-'));
}

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
