// `lorekit archive|delete|restore <scope::key>` — the removal lifecycle from the
// CLI, the counterpart to `write`.
//
//   archive <scope::key>            soft-archive (hide, reversible)
//   delete  <scope::key> [--force]  soft-archive, or hard-delete with --force
//   restore <scope::key>            un-archive a soft-archived memory
//
// All three address a memory the same `<scope::key>` way `write`/`list`/`show`
// do (or the explicit `<scope> <key>` / `--scope --key` forms), and pick a store
// with the same precedence `write` uses (remote when usable, else local; forced
// by --remote / --local). Server-side these map to the hosted memory.archive /
// memory.delete / memory.restore operations, which are scope-authorized for an
// API token by its allowlist (migrations 00071 / 00072): a key scoped to a
// scope may manage every writer's row in it, an unscoped key only its own.
import { resolveProjectRoot } from './config.mjs';
import { loadControl, resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { log, err, c } from './util.mjs';
import { resolveScopeKeyArgs, scopeIssue } from './lessons-view.mjs';

// The three surfaces return different success shapes: the remote store answers
// `{ ok, error, networkError }`, the local store `{ deleted, archived, entry }`.
// Treat any non-error positive signal as success, and a bare `ok: false` with no
// error as "nothing matched".
function outcome(res, op) {
  if (!res) return { ok: false, error: 'no response from store' };
  if (res.networkError) return { ok: false, error: res.networkError };
  if (res.error) return { ok: false, error: res.error };
  const changed =
    res.ok === true ||
    Boolean(res.entry) ||
    (op === 'restore' ? res.restored === true : res.deleted === true || res.archived === true);
  return { ok: changed, error: changed ? null : null };
}

function pickStore({ root, env, args }) {
  const { localDenied, remoteDenied } = resolveDenies(root, { env });
  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });
  const forceRemote = Boolean(args.remote);
  const forceLocal = Boolean(args.local);
  if (forceRemote && forceLocal) return { error: '--remote and --local are mutually exclusive' };

  if (forceRemote) {
    if (remoteDenied) return { error: `remote store is disabled by deny constraint (${remoteDenied.source})` };
    if (!remote.usable()) return { error: `remote store is not configured — ${remoteUnavailableReason(connection)}` };
    return { store: remote, storeName: 'remote' };
  }
  if (forceLocal) {
    if (localDenied) return { error: `local store is disabled by deny constraint (${localDenied.source})` };
    return { store: local, storeName: 'local' };
  }
  if (!remoteDenied && remote.usable()) return { store: remote, storeName: 'remote' };
  if (!localDenied) return { store: local, storeName: 'local' };
  return { error: `no writable store available — ${remoteUnavailableReason(connection)}` };
}

// One implementation for all three verbs; `op` selects the store method, the
// past-tense word, and (for delete) whether --force hard-deletes.
async function run(args, op) {
  const root = resolveProjectRoot(args.dir);
  const env = process.env;
  loadControl(root, { env });

  const positionals = args._.slice(1);
  const { scope, key } = resolveScopeKeyArgs(positionals, { scope: args.scope, key: args.key });

  const badScope = scope ? scopeIssue(scope) : null;
  if (badScope) {
    err(`${c.red('Error:')} invalid scope ${c.cyan(scope)} — ${badScope}`);
    return 1;
  }
  if (!scope || !key) {
    err(`${c.red('Usage:')} lorekit ${op} <scope::key>`);
    err(`       lorekit ${op} <scope> <key>`);
    err(`A scope and a key are required. Run ${c.cyan(`lorekit ${op} --help`)} for options.`);
    return 1;
  }

  const picked = pickStore({ root, env, args });
  if (picked.error) {
    err(`${c.red('Error:')} ${picked.error}`);
    return 1;
  }
  const { store, storeName } = picked;

  const force = op === 'delete' && Boolean(args.force);
  let res;
  if (op === 'archive') res = await store.archive({ scope, key });
  else if (op === 'restore') res = await store.restore({ scope, key });
  else res = await store.delete({ scope, key, force });

  const { ok, error } = outcome(res, op);
  const past = op === 'archive' ? 'archived' : op === 'restore' ? 'restored' : force ? 'deleted' : 'archived';

  if (args.json) {
    log(JSON.stringify({ ok, store: storeName, scope, key, op, force, error }, null, 2));
    return ok ? 0 : 1;
  }
  if (!ok) {
    err(`${c.red('Error:')} could not ${op} ${c.cyan(`${scope}::${key}`)}${error ? ` — ${error}` : ' — no matching memory (or not permitted for this token)'}`);
    return 1;
  }
  log(`${c.green('✓')} ${past} ${c.cyan(`${scope}::${key}`)} ${c.dim(`(${storeName})`)}`);
  return 0;
}

export function archive(args) { return run(args, 'archive'); }
export function del(args) { return run(args, 'delete'); }
export function restore(args) { return run(args, 'restore'); }
