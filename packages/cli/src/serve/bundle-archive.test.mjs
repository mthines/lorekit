import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packDirectory, unpackArchive, listEntriesRecursive, listFilesRecursive } from './bundle-archive.mjs';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('listFilesRecursive finds every real file at every depth, POSIX-separated', () => {
  const dir = tmp('lk-arc-src-');
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'top.txt'), 'top');
  fs.writeFileSync(path.join(dir, 'a', 'mid.txt'), 'mid');
  fs.writeFileSync(path.join(dir, 'a', 'b', 'deep.txt'), 'deep');

  const files = listFilesRecursive(dir).sort();
  assert.deepEqual(files, ['a/b/deep.txt', 'a/mid.txt', 'top.txt']);
});

test('pack + unpack round-trips file content and directory structure byte-for-byte', () => {
  const src = tmp('lk-arc-src-');
  fs.mkdirSync(path.join(src, 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(src, 'server.js'), 'console.log("hi")');
  fs.writeFileSync(path.join(src, 'nested', 'deep', 'file.bin'), Buffer.from([0, 1, 2, 255, 254]));
  fs.writeFileSync(path.join(src, 'empty.txt'), '');

  const archive = packDirectory(src);
  const dest = tmp('lk-arc-dest-');
  const { fileCount } = unpackArchive(archive, dest);
  assert.equal(fileCount, 3);

  assert.equal(fs.readFileSync(path.join(dest, 'server.js'), 'utf8'), 'console.log("hi")');
  assert.deepEqual(fs.readFileSync(path.join(dest, 'nested', 'deep', 'file.bin')), Buffer.from([0, 1, 2, 255, 254]));
  assert.equal(fs.readFileSync(path.join(dest, 'empty.txt'), 'utf8'), '');
});

test('round-trips a path far longer than tar\'s 100-char name limit', () => {
  const src = tmp('lk-arc-src-');
  const longSegment = 'a'.repeat(60);
  const relDir = path.posix.join('node_modules', '.pnpm', `some-package@1.2.3-${longSegment}`, 'node_modules', 'nested-dep', 'dist');
  fs.mkdirSync(path.join(src, ...relDir.split('/')), { recursive: true });
  fs.writeFileSync(path.join(src, ...relDir.split('/'), 'index.js'), 'module.exports = {};');

  const dest = tmp('lk-arc-dest-');
  unpackArchive(packDirectory(src), dest);
  assert.equal(
    fs.readFileSync(path.join(dest, ...relDir.split('/'), 'index.js'), 'utf8'),
    'module.exports = {};',
  );
});

test('listEntriesRecursive records a directory symlink as ITSELF, never descending into its contents', () => {
  const real = tmp('lk-arc-real-');
  fs.writeFileSync(path.join(real, 'package.json'), '{"name":"next"}');

  const src = tmp('lk-arc-src-');
  fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true });
  fs.symlinkSync(real, path.join(src, 'node_modules', 'next'), 'dir');

  const entries = listEntriesRecursive(src);
  assert.deepEqual(entries, [{ type: 'symlink', rel: 'node_modules/next', target: real, isDir: true }]);
});

test('pack + unpack PRESERVES a symlink as a symlink — this is the whole point (see module docblock)', () => {
  // The pnpm shape this regresses: a package's own "private" node_modules
  // (the symlink's real, un-copied sibling directory) must still be
  // reachable via the RECREATED symlink after extraction, exactly as it was
  // before packing — which only holds if the link itself round-trips, not a
  // dereferenced copy of its target.
  const store = tmp('lk-arc-store-');
  fs.mkdirSync(path.join(store, 'styled-jsx-real'), { recursive: true });
  fs.writeFileSync(path.join(store, 'styled-jsx-real', 'index.js'), 'module.exports = "styled-jsx";');

  const src = tmp('lk-arc-src-');
  fs.mkdirSync(path.join(src, 'pkg-real', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(src, 'pkg-real', 'index.js'), 'require("styled-jsx")');
  // A relative symlink — the pnpm convention — so it survives being copied
  // to an entirely different destination directory tree.
  fs.symlinkSync(
    path.relative(path.join(src, 'pkg-real', 'node_modules'), path.join(store, 'styled-jsx-real')),
    path.join(src, 'pkg-real', 'node_modules', 'styled-jsx'),
    'dir',
  );
  fs.mkdirSync(path.join(src, 'app', 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.relative(path.join(src, 'app', 'node_modules'), path.join(src, 'pkg-real')),
    path.join(src, 'app', 'node_modules', 'pkg'),
    'dir',
  );
  // The store directory is OUTSIDE `src` in this test to prove the relative
  // link still resolves after extraction to a different absolute location —
  // in the real bundle both live under the same standalone root, which is
  // the layout that actually ships.
  const combinedRoot = tmp('lk-arc-combined-');
  fs.cpSync(src, path.join(combinedRoot, 'src'), { recursive: true });
  fs.cpSync(store, path.join(combinedRoot, 'store'), { recursive: true });
  // Rewrite the symlink to be relative to its NEW position inside combinedRoot.
  fs.rmSync(path.join(combinedRoot, 'src', 'pkg-real', 'node_modules', 'styled-jsx'));
  fs.symlinkSync(
    path.relative(
      path.join(combinedRoot, 'src', 'pkg-real', 'node_modules'),
      path.join(combinedRoot, 'store', 'styled-jsx-real'),
    ),
    path.join(combinedRoot, 'src', 'pkg-real', 'node_modules', 'styled-jsx'),
    'dir',
  );

  const dest = tmp('lk-arc-dest-');
  const { symlinkCount } = unpackArchive(packDirectory(combinedRoot), dest);
  assert.equal(symlinkCount, 2);

  // Resolve exactly as Node's own module resolution would: through the
  // recreated symlinks, down to the real file.
  const resolved = fs.readFileSync(
    path.join(dest, 'src', 'app', 'node_modules', 'pkg', 'node_modules', 'styled-jsx', 'index.js'),
    'utf8',
  );
  assert.equal(resolved, 'module.exports = "styled-jsx";');
});

test('listEntriesRecursive does not lose one of two different symlinks pointing at the same real directory', () => {
  const real = tmp('lk-arc-real-');
  fs.writeFileSync(path.join(real, 'index.js'), 'shared');

  const src = tmp('lk-arc-src-');
  fs.mkdirSync(path.join(src, 'consumer-a'), { recursive: true });
  fs.mkdirSync(path.join(src, 'consumer-b'), { recursive: true });
  fs.symlinkSync(real, path.join(src, 'consumer-a', 'shared-dep'), 'dir');
  fs.symlinkSync(real, path.join(src, 'consumer-b', 'shared-dep'), 'dir');

  const rels = listEntriesRecursive(src).map((e) => e.rel).sort();
  assert.deepEqual(rels, ['consumer-a/shared-dep', 'consumer-b/shared-dep']);
});

test('listEntriesRecursive skips a broken symlink instead of throwing', () => {
  const src = tmp('lk-arc-src-');
  fs.symlinkSync(path.join(src, 'does-not-exist'), path.join(src, 'broken-link'));
  fs.writeFileSync(path.join(src, 'real.txt'), 'ok');

  assert.deepEqual(listEntriesRecursive(src), [{ type: 'file', rel: 'real.txt' }]);
});

test('unpackArchive throws (rather than silently truncating) on a corrupted archive', () => {
  const src = tmp('lk-arc-src-');
  fs.writeFileSync(path.join(src, 'f.txt'), 'hello');
  const archive = packDirectory(src);
  const dest = tmp('lk-arc-dest-');
  assert.throws(() => unpackArchive(archive.subarray(0, archive.length - 5), dest));
});

test('re-extracting over a previous partial symlink replaces it rather than throwing EEXIST', () => {
  const src = tmp('lk-arc-src-');
  fs.mkdirSync(path.join(src, 'node_modules'), { recursive: true });
  const real = tmp('lk-arc-real-');
  fs.symlinkSync(real, path.join(src, 'node_modules', 'pkg'), 'dir');

  const dest = tmp('lk-arc-dest-');
  const archive = packDirectory(src);
  unpackArchive(archive, dest);
  // Second extraction into the same destination must not throw.
  unpackArchive(archive, dest);
  assert.ok(fs.lstatSync(path.join(dest, 'node_modules', 'pkg')).isSymbolicLink());
});
