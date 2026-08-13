import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { bundleDirFor, resolveBundleUrl, ensureWebBundle, serverEntryFor, lorekitHome } from './bundle.mjs';
import { packDirectory } from './bundle-archive.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('lorekitHome / bundleDirFor honour $LOREKIT_HOME, mirroring control.mjs\'s per-user tier', () => {
  const env = { LOREKIT_HOME: '/tmp/custom-lorekit-home' };
  assert.equal(lorekitHome(env), '/tmp/custom-lorekit-home');
  assert.equal(bundleDirFor('1.2.3', env), path.join('/tmp/custom-lorekit-home', 'web', '1.2.3'));
});

test('resolveBundleUrl derives a version-pinned GitHub release URL by default', () => {
  const url = resolveBundleUrl('1.2.3', {});
  assert.match(url, /cli-v1\.2\.3/);
  assert.match(url, /lorekit-web-standalone-v1\.2\.3/);
});

test('resolveBundleUrl is fully overridable via $LOREKIT_WEB_BUNDLE_URL', () => {
  const url = resolveBundleUrl('1.2.3', { LOREKIT_WEB_BUNDLE_URL: 'https://example.test/custom.lkbundle.gz' });
  assert.equal(url, 'https://example.test/custom.lkbundle.gz');
});

test('ensureWebBundle is a cache hit when server.js already exists — never calls fetchImpl', async () => {
  const home = tmp('lk-bundle-home-');
  const dir = bundleDirFor('9.9.9', { LOREKIT_HOME: home });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(serverEntryFor(dir), 'already cached');

  let called = false;
  const result = await ensureWebBundle('9.9.9', {
    env: { LOREKIT_HOME: home },
    fetchImpl: async () => { called = true; throw new Error('must not be called on a cache hit'); },
  });
  assert.equal(called, false);
  assert.equal(result.cached, true);
  assert.equal(result.serverPath, serverEntryFor(dir));
});

test('ensureWebBundle fetches + extracts on a cache miss', async () => {
  const home = tmp('lk-bundle-home-');
  const fixture = tmp('lk-bundle-fixture-');
  fs.writeFileSync(path.join(fixture, 'server.js'), 'console.log("standalone")');
  fs.mkdirSync(path.join(fixture, '.next', 'static'), { recursive: true });
  fs.writeFileSync(path.join(fixture, '.next', 'static', 'chunk.js'), '/* chunk */');
  const archive = packDirectory(fixture);

  const result = await ensureWebBundle('1.0.0', {
    env: { LOREKIT_HOME: home },
    fetchImpl: async () => archive,
  });
  assert.equal(result.cached, false);
  assert.equal(fs.readFileSync(result.serverPath, 'utf8'), 'console.log("standalone")');
  assert.ok(fs.existsSync(path.join(result.dir, '.next', 'static', 'chunk.js')));
});

test('ensureWebBundle throws a clear error when the downloaded archive has no server.js', async () => {
  const home = tmp('lk-bundle-home-');
  const fixture = tmp('lk-bundle-fixture-');
  fs.writeFileSync(path.join(fixture, 'not-a-server.js'), 'oops');
  const archive = packDirectory(fixture);

  await assert.rejects(
    ensureWebBundle('2.0.0', { env: { LOREKIT_HOME: home }, fetchImpl: async () => archive }),
    /no server entry/,
  );
});

test('ensureWebBundle resolves the server entry through a monorepo-nesting manifest', async () => {
  const home = tmp('lk-bundle-home-');
  const fixture = tmp('lk-bundle-fixture-');
  fs.mkdirSync(path.join(fixture, 'packages', 'web'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'packages', 'web', 'server.js'), 'nested standalone entry');
  fs.mkdirSync(path.join(fixture, 'node_modules', 'next'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'node_modules', 'next', 'package.json'), '{}');
  fs.writeFileSync(
    path.join(fixture, 'lorekit-bundle-manifest.json'),
    JSON.stringify({ serverEntry: 'packages/web/server.js' }),
  );
  const archive = packDirectory(fixture);

  const result = await ensureWebBundle('5.0.0', { env: { LOREKIT_HOME: home }, fetchImpl: async () => archive });
  assert.equal(result.serverPath, path.join(result.dir, 'packages', 'web', 'server.js'));
  assert.equal(fs.readFileSync(result.serverPath, 'utf8'), 'nested standalone entry');
  assert.ok(fs.existsSync(path.join(result.dir, 'node_modules', 'next', 'package.json')), 'the outer node_modules must survive packing too');
});

test('the real HTTP(S) fetch path works end-to-end against a local server', async () => {
  const fixture = tmp('lk-bundle-fixture-');
  fs.writeFileSync(path.join(fixture, 'server.js'), 'real http path');
  const archive = packDirectory(fixture);

  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end(archive);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const home = tmp('lk-bundle-home-');
    const result = await ensureWebBundle('3.0.0', {
      env: { LOREKIT_HOME: home, LOREKIT_WEB_BUNDLE_URL: `http://127.0.0.1:${port}/bundle.lkbundle.gz` },
    });
    assert.equal(fs.readFileSync(result.serverPath, 'utf8'), 'real http path');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a non-200 response surfaces an actionable error rather than caching garbage', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const home = tmp('lk-bundle-home-');
    await assert.rejects(
      ensureWebBundle('4.0.0', {
        env: { LOREKIT_HOME: home, LOREKIT_WEB_BUNDLE_URL: `http://127.0.0.1:${port}/missing.lkbundle.gz` },
      }),
      /HTTP 404/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
