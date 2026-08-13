// `lorekit serve` (alias `web`) — D6: start the local REST shim over the
// resolved local store, then launch the Next.js dashboard against it, print
// both URLs, and tear both down on SIGINT/SIGTERM.
//
// Two launch paths for the dashboard:
//   --dev     the contributor path — spawns the source dev server from a repo
//             checkout (`pnpm --filter @lorekit/web dev`). Requires the repo.
//   (default) the end-user path — locates/fetches+caches the prebuilt
//             standalone bundle (`serve/bundle.mjs`) and runs its `server.js`
//             directly. Needs no repo checkout (AC-16).
//
// The two web-only auth-shim flags (D3) are set here, and ONLY here: the
// build-inlined `NEXT_PUBLIC_LOREKIT_LOCAL_MODE` (baked into the prebuilt
// bundle at build time by `scripts/build-web-bundle.mjs`; the dev server
// picks it up from this process's env at boot) and the runtime
// `LOREKIT_LOCAL_MODE` the server-side auth shim + middleware read on every
// request.
//
// Zero-dependency: node:* only.
import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { localStoreDirs } from './control.mjs';
import { createTwoTierStore } from './store/index.mjs';
import { resolveProjectRoot, PKG_ROOT } from './config.mjs';
import { createRoutes } from './serve/routes.mjs';
import { createShimServer } from './serve/http.mjs';
import { ensureWebBundle } from './serve/bundle.mjs';
import { c, log, err } from './util.mjs';

export const DEFAULT_SHIM_PORT = 4850;
export const DEFAULT_WEB_PORT = 4851;
const MAX_PORT_ATTEMPTS = 20;

const CLI_VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

/**
 * Listen on `startPort`, retrying the next port on `EADDRINUSE` up to
 * `MAX_PORT_ATTEMPTS` times. Resolves to the port actually bound — the shim
 * and the dashboard both need a free port, and a developer running two
 * projects' `lorekit serve` at once must not have to guess one by hand.
 */
export function listenWithRetry(server, host, startPort, { maxAttempts = MAX_PORT_ATTEMPTS } = {}) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    let attempts = 0;
    const tryListen = () => {
      const onError = (e) => {
        server.removeListener('error', onError);
        if (e && e.code === 'EADDRINUSE' && attempts < maxAttempts) {
          attempts += 1;
          port += 1;
          tryListen();
        } else {
          reject(e);
        }
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        // Read back the OS-assigned port rather than trusting the loop
        // variable — `startPort: 0` ("let the OS choose") must resolve to
        // the port actually bound, not the literal 0 that was requested.
        resolve(server.address().port);
      });
    };
    tryListen();
  });
}

// The monorepo root, assuming `packages/cli` sits exactly two directories
// below it — true for a repo checkout, which `--dev` requires by definition.
function repoRootFromPkg() {
  return path.resolve(PKG_ROOT, '..', '..');
}

/** Best-effort, non-blocking "open this URL in the default browser". Never
 * throws and never delays startup — a failure to find a browser opener must
 * not stop the servers that are already up. */
function openBrowser(url) {
  try {
    const platform = process.platform;
    const [cmd, args] = platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No opener available (headless CI, minimal container) — the printed URL
    // is still right there for the user to click or copy.
  }
}

/**
 * Resolve the { command, args } to launch the dashboard with.
 *
 * `env.LOREKIT_SERVE_WEB_CMD` (a JSON `{ command, args }`) is an internal test
 * seam — never documented in `--help` — letting `serve-cli.test.mjs` swap in a
 * trivial long-running process instead of booting a real Next.js server, so
 * the SIGINT-teardown test stays fast and hermetic while still spawning the
 * REAL CLI binary end-to-end.
 */
async function resolveWebLaunch({ dev, webPort, env }) {
  if (env.LOREKIT_SERVE_WEB_CMD) {
    try {
      const parsed = JSON.parse(env.LOREKIT_SERVE_WEB_CMD);
      if (parsed && typeof parsed.command === 'string') {
        return { command: parsed.command, args: Array.isArray(parsed.args) ? parsed.args : [], cwd: process.cwd() };
      }
    } catch {
      // Fall through to the real resolution — a malformed override must not
      // silently disable the real launch path.
    }
  }

  if (dev) {
    return {
      command: 'pnpm',
      args: ['--filter', '@lorekit/web', 'dev', '-p', String(webPort)],
      cwd: repoRootFromPkg(),
    };
  }

  const bundle = await ensureWebBundle(CLI_VERSION, { env });
  return { command: process.execPath, args: [bundle.serverPath], cwd: bundle.dir };
}

/**
 * `lorekit serve` entrypoint. Resolves the local store (always local — this
 * command's whole purpose is local mode, so it never consults
 * `resolveControl`'s mode selection), starts the shim, launches the
 * dashboard, and blocks until the dashboard process exits (normally via
 * SIGINT/SIGTERM, which tears both down).
 */
export async function serve(args = {}, { env = process.env } = {}) {
  const root = resolveProjectRoot(args.dir);
  const dirs = localStoreDirs(root, env);
  const store = createTwoTierStore(dirs);

  const shimServer = createShimServer(createRoutes({ store }));
  const shimPortWanted = Number(args.port) || DEFAULT_SHIM_PORT;
  const webPortWanted = Number(args['web-port']) || DEFAULT_WEB_PORT;

  const shimPort = await listenWithRetry(shimServer, '127.0.0.1', shimPortWanted);
  const shimUrl = `http://127.0.0.1:${shimPort}`;

  log(`${c.bold('lorekit serve')} — local web dev mode`);
  log(`  store:     ${c.dim(dirs.project)} ${c.dim(`(+ ${dirs.home})`)}`);
  log(`  shim:      ${c.cyan(shimUrl + '/functions/v1')}`);

  const webEnv = {
    ...env,
    NEXT_PUBLIC_SUPABASE_URL: shimUrl,
    // A placeholder is enough — the shim ignores the token's value (D3/D8:
    // one implicit local user), but supabase-js's client constructor still
    // requires a non-empty anon key to avoid throwing on creation.
    NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'lorekit-local-dev-mode',
    NEXT_PUBLIC_LOREKIT_LOCAL_MODE: '1',
    LOREKIT_LOCAL_MODE: '1',
    PORT: String(webPortWanted),
    HOSTNAME: '127.0.0.1',
  };

  const launch = await resolveWebLaunch({ dev: Boolean(args.dev), webPort: webPortWanted, env });
  const webProc = spawn(launch.command, launch.args, { cwd: launch.cwd, env: webEnv, stdio: 'inherit' });

  const webUrl = `http://127.0.0.1:${webPortWanted}`;
  log(`  dashboard: ${c.cyan(webUrl)}${args.dev ? c.dim('  (source dev server)') : ''}`);
  log(c.dim('\n  Press Ctrl-C to stop.\n'));

  if (!args['no-open'] && !env.LOREKIT_SERVE_WEB_CMD) openBrowser(webUrl);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${c.dim(`Received ${signal}, shutting down…`)}`);
    shimServer.close();
    if (webProc.exitCode === null && !webProc.killed) webProc.kill('SIGTERM');
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return new Promise((resolve) => {
    webProc.on('exit', (code) => {
      shutdown('dashboard process exit');
      resolve(code ?? 0);
    });
    webProc.on('error', (e) => {
      err(`${c.red('Error:')} failed to launch the dashboard process: ${e.message}`);
      shutdown('dashboard process error');
      resolve(1);
    });
  });
}

// Re-exported so `bin/lorekit.mjs` and tests can resolve the repo root the
// same way `--dev` does, without duplicating the "two dirs up" assumption.
export { repoRootFromPkg };
