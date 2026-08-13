#!/usr/bin/env node
/**
 * Build `packages/web` as a prebuilt, standalone bundle and package it into
 * the private archive format `lorekit serve` (no `--dev`) fetches and
 * launches — the producer half of `packages/cli/src/serve/bundle.mjs` (D7/P2).
 *
 * Steps:
 *   1. `next build` with `NEXT_PUBLIC_LOREKIT_LOCAL_MODE=1` baked in at BUILD
 *      time (Next.js inlines `NEXT_PUBLIC_*` env vars into the client bundle —
 *      this is the ONE place that flag is ever set for a bundle that will run
 *      in production; the Vercel build never sets it, so the hosted bundle
 *      never contains the local-mode branch — D3's whole point).
 *   2. Assemble Next's documented standalone layout: `.next/standalone` is the
 *      self-contained server, but Next does not copy `.next/static` or
 *      `public/` into it — the deploy target has to (see
 *      https://nextjs.org/docs/pages/api-reference/config/next-config-js/output).
 *   3. Pack the assembled directory with the CLI's own archive format
 *      (`serve/bundle-archive.mjs` — see that module for why not tar/zip) and
 *      write it to `--out` (default `dist/lorekit-web-standalone-v<version>.lkbundle.gz`,
 *      version-pinned to the CLI's own `package.json` version, matching
 *      `resolveBundleUrl`'s naming convention exactly).
 *
 * Release/CI wiring (uploading this artifact to a GitHub release keyed by
 * the CLI version) is documented, not automated here — see docs/local-web.md
 * — because this sandbox's GitHub App has no `workflows` permission (plan
 * D7 / the `workflow-files-need-human-commit` lesson).
 *
 * Zero-dependency: node:* + the sibling CLI archive module only.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packDirectory } from '../packages/cli/src/serve/bundle-archive.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = path.join(REPO_ROOT, 'packages', 'web');

function parseArgs(argv) {
  const out = { out: null, skipBuild: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--skip-build') out.skipBuild = true;
  }
  return out;
}

function cliVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'cli', 'package.json'), 'utf8'));
  return pkg.version;
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
  if (res.status !== 0) {
    throw new Error(`command failed (${res.status}): ${command} ${args.join(' ')}`);
  }
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = cliVersion();
  const outPath = args.out || path.join(REPO_ROOT, 'dist', `lorekit-web-standalone-v${version}.lkbundle.gz`);

  if (!args.skipBuild) {
    // eslint-disable-next-line no-console
    console.log('[build-web-bundle] building packages/web with output: "standalone" ' +
      'and NEXT_PUBLIC_LOREKIT_LOCAL_MODE=1 baked in…');
    run('pnpm', ['--filter', '@lorekit/web', 'build'], {
      env: {
        ...process.env,
        // The ONE build that ever sets this — see the module docblock.
        NEXT_PUBLIC_LOREKIT_LOCAL_MODE: '1',
      },
    });
  }

  const standaloneDir = path.join(WEB_DIR, '.next', 'standalone');
  if (!fs.existsSync(standaloneDir)) {
    throw new Error(
      `[build-web-bundle] ${standaloneDir} does not exist — did the build run with output: 'standalone' set ` +
      'in next.config.ts?',
    );
  }

  // eslint-disable-next-line no-console
  console.log('[build-web-bundle] assembling static assets + public/ into the standalone output…');
  // Next's own layout: the standalone server expects these at
  // <standalone>/packages/web/.next/static and <standalone>/packages/web/public
  // — nested under the workspace path the monorepo build produced, mirroring
  // how `packages/web/.next/standalone/packages/web/server.js` is laid out by
  // a pnpm-workspace Next build (the same reason it is NOT simply
  // `<standalone>/.next/static` for a monorepo).
  const nestedWebDir = fs.existsSync(path.join(standaloneDir, 'packages', 'web'))
    ? path.join(standaloneDir, 'packages', 'web')
    : standaloneDir;
  copyRecursive(path.join(WEB_DIR, '.next', 'static'), path.join(nestedWebDir, '.next', 'static'));
  copyRecursive(path.join(WEB_DIR, 'public'), path.join(nestedWebDir, 'public'));

  const serverEntry = path.join(nestedWebDir, 'server.js');
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`[build-web-bundle] no server.js found under ${nestedWebDir} — the standalone build output is unexpected`);
  }

  // Pack the WHOLE standalone directory, not just the nested server.js's own
  // directory: a pnpm-workspace Next build hoists the deduped `node_modules`
  // to the OUTER `standaloneDir` (Node's own upward node_modules resolution
  // is what lets `packages/web/server.js` find `require('next')` there at
  // runtime), so packing only the nested directory silently drops every
  // dependency and the launched server fails with `Cannot find module
  // 'next'`. A manifest records where `server.js` actually landed, so
  // `bundle.mjs` does not have to guess the monorepo's nesting depth.
  fs.writeFileSync(
    path.join(standaloneDir, 'lorekit-bundle-manifest.json'),
    JSON.stringify({ serverEntry: path.relative(standaloneDir, serverEntry).split(path.sep).join('/') }, null, 2),
  );

  // eslint-disable-next-line no-console
  console.log(`[build-web-bundle] packing ${standaloneDir} → ${outPath}`);
  const archive = packDirectory(standaloneDir);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, archive);

  // eslint-disable-next-line no-console
  console.log(`[build-web-bundle] wrote ${outPath} (${(archive.length / 1024 / 1024).toFixed(1)} MiB)`);
  // eslint-disable-next-line no-console
  console.log(
    '[build-web-bundle] upload this file to the GitHub release tagged ' +
    `cli-v${version} as lorekit-web-standalone-v${version}.lkbundle.gz — see docs/local-web.md.`,
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
