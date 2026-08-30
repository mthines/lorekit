// `lorekit completion <zsh|fish>` — print a shell completion script.
//
// The generated scripts (see ../shared/completions.mjs) call back into this
// command for DYNAMIC values: `lorekit completion --complete scope` lists the
// scopes in the local store, `--complete key` lists `scope::key` addresses. That
// callback fires on every TAB, which is why `completion` is a MACHINE command in
// the registry — its stdout is a contract a shell parses (a script or a
// newline-delimited candidate list), and it is metered, not traced, exactly like
// `hook` / `mcp`. A span per keypress would be a firehose.
//
// Dynamic completion reads the LOCAL store only. It is deliberately offline: a
// TAB must be instant and must never prompt for a token or hit the network, so a
// scope that lives only in the remote store will not complete — a worthwhile
// trade for a completion that never blocks the prompt.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { resolveStores } from '../shared/stores.mjs';
import { log, err, c } from '../shared/util.mjs';
import { COMPLETION_SHELLS, renderCompletion } from '../shared/completions.mjs';

export async function completion(args) {
  // Dynamic candidate mode: emit newline-delimited candidates for the shell to
  // consume, then exit. Any failure degrades to an empty list (exit 0) so a
  // broken store never surfaces an error at the prompt.
  if (args.complete !== undefined) {
    return emitCandidates(args);
  }

  const shell = typeof args._?.[1] === 'string' ? args._[1] : null;
  if (!shell) {
    err(`${c.red('Missing shell.')} Usage: lorekit completion <${COMPLETION_SHELLS.join('|')}>`);
    return 1;
  }
  if (!COMPLETION_SHELLS.includes(shell)) {
    err(`${c.red(`Unsupported shell: ${shell}.`)} Supported: ${COMPLETION_SHELLS.join(', ')}`);
    err(`Run ${c.cyan('lorekit install --completions ' + shell)} to install it, or pipe this to your shell's completion dir.`);
    return 1;
  }

  log(renderCompletion(shell));
  return 0;
}

// Emit the candidate list for `--complete <kind>`. `scope` → distinct scope
// strings; `key` → `scope::key` addresses. Best-effort and offline.
async function emitCandidates(args) {
  const kind = typeof args.complete === 'string' ? args.complete : '';
  try {
    const root = resolveProjectRoot(args.dir);
    const { local } = resolveStores(root, { env: process.env });
    const inventory = await local.listScopes();

    if (kind === 'scope') {
      for (const { scope } of inventory) log(scope);
      return 0;
    }
    if (kind === 'key') {
      for (const { scope } of inventory) {
        const res = await local.list({ scope });
        for (const entry of res.entries ?? []) log(`${scope}::${entry.key}`);
      }
      return 0;
    }
  } catch {
    // Swallow — an unreadable store yields no candidates, never a prompt error.
  }
  return 0;
}
