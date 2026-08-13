// A tiny, zero-dependency archive format for the prebuilt web bundle (D7/P2).
//
// Not tar, not zip — a private container only this module's own producer
// (`scripts/build-web-bundle.mjs`) and consumer (`bundle.mjs`) need to agree
// on, which sidesteps tar's 100-char name limit (a Next.js standalone output
// routinely nests `node_modules/.pnpm/<long-name>@<version>/...` paths past
// that) without pulling in a zip/tar dependency.
//
// SYMLINKS ARE PRESERVED, NEVER DEREFERENCED. This is the one design point
// worth explaining, because the earlier version of this module got it wrong:
// dereferencing (copying a symlink's target content to the symlink's own
// path) seems simpler, but it silently BREAKS a pnpm-workspace install. pnpm
// gives each package its own "private" `node_modules` inside the content-
// addressable store — `.pnpm/next@<hash>/node_modules/{next,styled-jsx,…}` —
// and Node's module resolution walks up from a required file's REAL
// (symlink-resolved) location to find those private sibling directories.
// Copying just the symlink's target subtree to a new location discards that
// enclosing directory entirely, so a package that requires one of ITS OWN
// (rather than the top-level app's) private dependencies — `next` requiring
// `styled-jsx`, in practice — can no longer resolve it. Preserving the
// symlink itself, with its ORIGINAL (always relative, in a pnpm store)
// target string, keeps the exact resolution graph intact: extracting the
// whole tree to one destination directory reproduces the same relative
// layout the symlinks were minted for.
//
// Framing, per entry:
//
//   uint8      type: 0 = file, 1 = symlink
//   uint32 LE  pathByteLength
//   bytes      path (UTF-8, POSIX separators)
//   — file —
//   uint32 LE  contentByteLength
//   bytes      content
//   — symlink —
//   uint8      isDir (the symlink's resolved target's type — needed for
//              `fs.symlinkSync`'s Windows-only `type` argument; harmless and
//              unused on POSIX)
//   uint32 LE  targetByteLength
//   bytes      target (the RAW `readlinkSync` string, unresolved)
//
// repeated until the buffer is exhausted. The whole stream is gzip-compressed
// (`node:zlib`) for network transfer. Directories are implicit — `unpack`
// creates them via `fs.mkdirSync(..., { recursive: true })` from each entry's
// path, so an empty directory is simply never represented.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TYPE_FILE = 0;
const TYPE_SYMLINK = 1;

/**
 * Recursively list every entry under `dir` — files AND symlinks (a symlink is
 * recorded as itself, its contents never walked; see the module docblock for
 * why dereferencing is the wrong move here). Paths are POSIX-style, relative
 * to `dir`.
 *
 * A dangling symlink (`readlinkSync`/`statSync` failing) is skipped rather
 * than failing the whole walk — the same "one bad entry narrows, it never
 * breaks the run" posture the rest of this codebase's directory walks take
 * (`_walkEntries`).
 */
export function listEntriesRecursive(dir) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    let dirents;
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip rather than throw
    }
    for (const entry of dirents) {
      const relChild = rel ? `${rel}/${entry.name}` : entry.name;
      const absChild = path.join(dir, relChild);

      if (entry.isSymbolicLink()) {
        let target;
        let isDir;
        try {
          target = fs.readlinkSync(absChild);
          isDir = fs.statSync(absChild).isDirectory(); // follows the link to learn its type only
        } catch {
          continue; // dangling symlink — skip it
        }
        out.push({ type: 'symlink', rel: relChild, target, isDir });
        continue; // never descend into a symlinked directory's contents
      }
      if (entry.isDirectory()) {
        walk(relChild);
      } else if (entry.isFile()) {
        out.push({ type: 'file', rel: relChild });
      }
    }
  };
  walk('');
  return out;
}

/** Back-compat name some callers/tests may still reach for: files only, symlinked directories followed shallowly is NOT what this returns — prefer {@link listEntriesRecursive}. Kept as a thin filter over it. */
export function listFilesRecursive(dir) {
  return listEntriesRecursive(dir)
    .filter((e) => e.type === 'file')
    .map((e) => e.rel);
}

function writeUint32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

/** Pack `dir` into a gzip-compressed archive buffer, symlinks preserved as symlinks. */
export function packDirectory(dir) {
  const entries = listEntriesRecursive(dir);
  const parts = [];
  for (const entry of entries) {
    const pathBuf = Buffer.from(entry.rel, 'utf8');
    if (entry.type === 'symlink') {
      const targetBuf = Buffer.from(entry.target, 'utf8');
      parts.push(
        Buffer.from([TYPE_SYMLINK]),
        writeUint32LE(pathBuf.length), pathBuf,
        Buffer.from([entry.isDir ? 1 : 0]),
        writeUint32LE(targetBuf.length), targetBuf,
      );
    } else {
      const content = fs.readFileSync(path.join(dir, entry.rel));
      parts.push(
        Buffer.from([TYPE_FILE]),
        writeUint32LE(pathBuf.length), pathBuf,
        writeUint32LE(content.length), content,
      );
    }
  }
  return zlib.gzipSync(Buffer.concat(parts));
}

/**
 * Extract a `packDirectory` archive into `destDir`, creating it and every
 * intermediate directory as needed, and recreating symlinks (never
 * dereferenced) with their exact original target string.
 *
 * Total: throws only on a genuinely corrupt/truncated archive (a framing
 * length that runs past the buffer) — the caller (`bundle.mjs`) is expected
 * to have already validated the download succeeded before calling this.
 * An already-existing symlink at the target path (e.g. a re-extraction over
 * a partial previous one) is replaced rather than left stale.
 */
export function unpackArchive(gzipped, destDir) {
  const buf = zlib.gunzipSync(gzipped);
  let offset = 0;
  let fileCount = 0;
  let symlinkCount = 0;

  const readUint32 = () => {
    if (offset + 4 > buf.length) throw new Error('lorekit web bundle: truncated archive (length field)');
    const n = buf.readUInt32LE(offset);
    offset += 4;
    return n;
  };
  const readBytes = (n) => {
    if (offset + n > buf.length) throw new Error('lorekit web bundle: truncated archive (data)');
    const b = buf.subarray(offset, offset + n);
    offset += n;
    return b;
  };

  while (offset < buf.length) {
    if (offset + 1 > buf.length) throw new Error('lorekit web bundle: truncated archive (entry type)');
    const type = buf[offset];
    offset += 1;

    const pathLen = readUint32();
    const relPath = readBytes(pathLen).toString('utf8');
    const target = path.join(destDir, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (type === TYPE_SYMLINK) {
      const isDir = buf[offset] === 1;
      offset += 1;
      const targetLen = readUint32();
      const linkTarget = readBytes(targetLen).toString('utf8');
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // Nothing there yet — fine.
      }
      fs.symlinkSync(linkTarget, target, isDir ? 'dir' : 'file');
      symlinkCount++;
    } else if (type === TYPE_FILE) {
      const contentLen = readUint32();
      const content = readBytes(contentLen);
      fs.writeFileSync(target, content);
      fileCount++;
    } else {
      throw new Error(`lorekit web bundle: unknown archive entry type ${type} at offset ${offset - 1}`);
    }
  }
  return { fileCount, symlinkCount };
}
