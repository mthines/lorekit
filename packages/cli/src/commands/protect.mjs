// `lorekit protect <scope::key> [--off]` / `lorekit pin|unpin <scope::key>`
//
// Marks or unmarks a lesson as protected — excluded from every grooming
// candidate set regardless of policy. `protect` is the catalog's
// `memory.protect` operation (pass `--off` to unprotect); `pin`/`unpin` are
// convenience commands that call the SAME underlying REST call with the value
// fixed, matching the plan's "pin/unpin aliases handled in the handler" —
// implemented as two extra COMMANDS entries rather than catalog cliAliases,
// since an alias only renames a command to an identical-behaviour canonical
// one and pin/unpin invert the boolean.
import { resolveProjectRoot } from '../shared/config.mjs';
import { loadControl, resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { log, err, c } from '../shared/util.mjs';
import { resolveScopeKeyArgs, scopeIssue } from '../shared/lessons-view.mjs';

function pickRemote({ root, env, args }) {
  const { remoteDenied } = resolveDenies(root, { env });
  const { remote, connection } = resolveStores(root, { env, endpoint: args.endpoint, token: args.token });
  if (remoteDenied) return { error: `remote store is disabled by deny constraint (${remoteDenied.source})` };
  if (!remote.usable()) return { error: `remote store is not configured — ${remoteUnavailableReason(connection)}` };
  return { store: remote };
}

// One implementation for all four verbs; `isProtected` selects the value,
// `verb` only changes the printed word.
async function run(args, isProtected, verb) {
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
    err(`${c.red('Usage:')} lorekit ${verb} <scope::key>`);
    err(`       lorekit ${verb} <scope> <key>`);
    return 1;
  }

  const picked = pickRemote({ root, env, args });
  if (picked.error) {
    err(`${c.red('Error:')} ${picked.error}`);
    return 1;
  }

  const res = await picked.store.protect({ scope, key, protected: isProtected });
  if (!res.ok) {
    const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
    if (args.json) {
      log(JSON.stringify({ ok: false, scope, key, protected: null, error: String(msg) }, null, 2));
      return 1;
    }
    err(`${c.red('Error:')} could not ${verb} ${c.cyan(`${scope}::${key}`)} — ${msg}`);
    return 1;
  }
  if (args.json) {
    log(JSON.stringify({ ok: true, scope, key, protected: res.protected }, null, 2));
    return 0;
  }
  const past = isProtected ? 'protected' : 'unprotected';
  log(`${c.green('✓')} ${past} ${c.cyan(`${scope}::${key}`)} ${c.dim('(remote)')}`);
  return 0;
}

export function protect(args) { return run(args, !args.off, 'protect'); }
export function pin(args) { return run(args, true, 'pin'); }
export function unpin(args) { return run(args, false, 'unpin'); }
