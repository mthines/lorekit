// Locate, lazily fetch, and cache the prebuilt Next.js standalone web bundle
// (D7/P2) — the piece that lets `lorekit serve` (no `--dev`) launch the
// dashboard with no repo checkout. `scripts/build-web-bundle.mjs` is this
// module's producer: it builds `packages/web` with `output: 'standalone'` and
// `NEXT_PUBLIC_LOREKIT_LOCAL_MODE=1` baked in, then calls `packDirectory` to
// write the archive this module downloads and extracts.
//
// Cache layout: `~/.lorekit/web/<version>/` (honours `$LOREKIT_HOME`, the same
// override `control.mjs` uses for the per-user tier) holds one extracted
// bundle per CLI version — `server.js` at its root is the Next.js standalone
// entrypoint. A version already cached is never re-downloaded.
//
// Zero-dependency: `node:https`/`node:http` (URL-scheme-dispatched) + the
// sibling `bundle-archive.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import { unpackArchive } from './bundle-archive.mjs';

/** `~/.lorekit` (or `$LOREKIT_HOME`) — the same per-user root `control.mjs` resolves. */
export function lorekitHome(env = process.env) {
  return env.LOREKIT_HOME || path.join(os.homedir(), '.lorekit');
}

/** Where a given version's extracted bundle lives (or would live). */
export function bundleDirFor(version, env = process.env) {
  return path.join(lorekitHome(env), 'web', version);
}

/**
 * The download URL for a version's bundle archive.
 *
 * `$LOREKIT_WEB_BUNDLE_URL` overrides the whole URL outright (used by tests,
 * and by anyone self-hosting the artifact); otherwise it is derived from the
 * GitHub Releases convention `release.yml`'s `publish-cli` job is documented
 * to upload to (see docs/local-web.md) — a release asset named after the CLI
 * version it ships alongside, since the bundle and the CLI that launches it
 * must agree on the `NEXT_PUBLIC_LOREKIT_LOCAL_MODE` contract between them.
 */
export function resolveBundleUrl(version, env = process.env) {
  if (env.LOREKIT_WEB_BUNDLE_URL) return env.LOREKIT_WEB_BUNDLE_URL;
  return `https://github.com/mthines/lorekit/releases/download/cli-v${version}/lorekit-web-standalone-v${version}.lkbundle.gz`;
}

function fetchBuffer(url, { redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    client
      .get(url, (res) => {
        const { statusCode = 0 } = res;
        if (statusCode >= 300 && statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          fetchBuffer(new URL(res.headers.location, url).toString(), { redirectsLeft: redirectsLeft - 1 })
            .then(resolve, reject);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`lorekit web bundle: download failed with HTTP ${statusCode} from ${url}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

const MANIFEST_NAME = 'lorekit-bundle-manifest.json';

/**
 * The Next.js standalone entrypoint inside an extracted bundle directory.
 *
 * Reads `lorekit-bundle-manifest.json` (written by `build-web-bundle.mjs`) for
 * the server's path RELATIVE to the archive root — a pnpm-workspace Next
 * build nests `server.js` under the package's own workspace path
 * (`packages/web/server.js` in this repo), and packing must preserve the
 * OUTER directory too (Node resolves `require('next')` by walking UP from
 * `server.js`, and that is where the deduped `node_modules` actually landed).
 * Falls back to `<dir>/server.js` when no manifest is present, so an archive
 * built for a non-monorepo layout (or hand-assembled) still resolves.
 */
export function serverEntryFor(dir) {
  const manifestPath = path.join(dir, MANIFEST_NAME);
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest && typeof manifest.serverEntry === 'string' && manifest.serverEntry) {
      return path.join(dir, ...manifest.serverEntry.split('/'));
    }
  } catch {
    // No manifest (or unreadable) — fall through to the flat-layout default.
  }
  return path.join(dir, 'server.js');
}

/**
 * Locate the bundle for `version`, fetching + extracting it into the cache on
 * a miss. Returns `{ dir, serverPath }`. Never re-downloads a version whose
 * server entry already exists on disk — the version-pinned cache is what
 * makes that safe: a given version's build output never changes underneath
 * it.
 *
 * `fetchImpl` is injectable (defaults to the real HTTP(S) client) purely for
 * testing against a local fixture server without a network dependency.
 */
export async function ensureWebBundle(version, { env = process.env, fetchImpl = fetchBuffer } = {}) {
  const dir = bundleDirFor(version, env);
  if (fs.existsSync(serverEntryFor(dir))) return { dir, serverPath: serverEntryFor(dir), cached: true };

  const url = resolveBundleUrl(version, env);
  const archive = await fetchImpl(url);
  fs.mkdirSync(dir, { recursive: true });
  unpackArchive(archive, dir);

  const serverPath = serverEntryFor(dir);
  if (!fs.existsSync(serverPath)) {
    throw new Error(
      `lorekit web bundle: extracted ${dir} but found no server entry (${serverPath}) — the downloaded archive ` +
      'is not a valid Next.js standalone bundle',
    );
  }
  return { dir, serverPath, cached: false };
}
