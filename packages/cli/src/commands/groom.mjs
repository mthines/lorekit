// `lorekit groom` — preview or run a retention sweep.
//
//   groom [--policy-id ID | --scope SCOPE] [conditions...] [--dry-run]   preview candidates (default)
//   groom [--policy-id ID | --scope SCOPE] [conditions...] --run [--yes] archive them
//
// Server-side only — retention policies and grooming have no local-store
// equivalent (matching purge/purge-expired), so this command is REMOTE ONLY.
// `--policy-id` reuses a saved rule; `--scope` + conditions build one inline.
// Exactly one of the two is required.
import { resolveProjectRoot } from '../shared/config.mjs';
import { loadControl, resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { log, err, c, select } from '../shared/util.mjs';
import { parseIntFlag } from '../shared/flags.mjs';

/** Resolve the groom.preview/groom.run request from CLI args. */
export function parseGroomRequest(args) {
  if (args['policy-id'] && args.scope) {
    return { error: '--policy-id and --scope are mutually exclusive — pass one or the other' };
  }
  if (!args['policy-id'] && !args.scope) {
    return { error: 'either --policy-id or --scope is required' };
  }
  if (args['policy-id']) return { request: { policy_id: args['policy-id'] } };

  const minAge = parseIntFlag(args['min-age-days'], 'min-age-days');
  if (minAge.error) return { error: minAge.error };
  const unseen = parseIntFlag(args['unseen-days'], 'unseen-days');
  if (unseen.error) return { error: unseen.error };
  const maxSeen = parseIntFlag(args['max-seen-count'], 'max-seen-count');
  if (maxSeen.error) return { error: maxSeen.error };
  const maxRead = parseIntFlag(args['max-read-count'], 'max-read-count');
  if (maxRead.error) return { error: maxRead.error };
  const maxOpened = parseIntFlag(args['max-opened-count'], 'max-opened-count');
  if (maxOpened.error) return { error: maxOpened.error };

  return {
    request: {
      scope: args.scope,
      min_age_days: minAge.value,
      unseen_days: unseen.value,
      max_seen_count: maxSeen.value,
      max_read_count: maxRead.value,
      max_opened_count: maxOpened.value,
    },
  };
}

function pickRemote({ root, env, args }) {
  const { remoteDenied } = resolveDenies(root, { env });
  const { remote, connection } = resolveStores(root, { env, endpoint: args.endpoint, token: args.token });
  if (remoteDenied) return { error: `remote store is disabled by deny constraint (${remoteDenied.source})` };
  if (!remote.usable()) return { error: `remote store is not configured — ${remoteUnavailableReason(connection)}` };
  return { store: remote };
}

export async function groom(args) {
  const root = resolveProjectRoot(args.dir);
  const env = process.env;
  loadControl(root, { env });

  const parsed = parseGroomRequest(args);
  if (parsed.error) {
    err(`${c.red('Error:')} ${parsed.error}`);
    return 1;
  }

  const picked = pickRemote({ root, env, args });
  if (picked.error) {
    err(`${c.red('Error:')} ${picked.error}`);
    return 1;
  }

  const run = Boolean(args.run);

  // Preview is the default and is never gated — it changes nothing.
  if (!run) {
    const res = await picked.store.groomPreview(parsed.request);
    if (!res.ok) {
      const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
      if (args.json) {
        log(JSON.stringify({ ok: false, op: 'preview', count: null, keys: [], error: String(msg) }, null, 2));
        return 1;
      }
      err(`${c.red('Error:')} ${msg}`);
      return 1;
    }
    if (args.json) {
      log(JSON.stringify({ ok: true, op: 'preview', count: res.count, keys: res.keys }, null, 2));
      return 0;
    }
    log(`${c.cyan(String(res.count))} lesson${res.count === 1 ? '' : 's'} would be archived:`);
    for (const k of res.keys.slice(0, 20)) log(`  ${c.dim(k.scope)}::${k.key}`);
    if (res.keys.length > 20) log(c.dim(`  … and ${res.keys.length - 20} more`));
    log(c.dim('Re-run with --run to archive them.'));
    return 0;
  }

  // --run archives — a real, if recoverable (soft-archive), mutation. Gate it
  // the same way as any lorekit action that changes state unattended: a
  // preview count first, then confirm-or-`--yes`.
  const preview = await picked.store.groomPreview(parsed.request);
  if (!preview.ok) {
    const msg = preview.error?.message ?? preview.error ?? preview.networkError ?? 'the server rejected the request';
    err(`${c.red('Error:')} ${msg}`);
    return 1;
  }

  if (preview.count === 0) {
    if (args.json) {
      log(JSON.stringify({ ok: true, op: 'run', archived: 0, keys: [] }, null, 2));
      return 0;
    }
    log(`${c.dim('Nothing to archive — 0 lessons match.')}`);
    return 0;
  }

  const decision = args.yes ? 'proceed' : (args.json || !process.stdin.isTTY) ? 'refuse' : 'prompt';
  if (decision === 'refuse') {
    err(`${c.red('Refusing:')} would archive ${preview.count} lesson${preview.count === 1 ? '' : 's'} with no terminal to confirm.`);
    err(`Re-run with ${c.cyan('--yes')} to confirm.`);
    return 1;
  }
  if (decision === 'prompt') {
    const go = await select(
      `${c.bold('Archive')} ${preview.count} lesson${preview.count === 1 ? '' : 's'}? Recoverable via restore.`,
      [
        { value: false, label: 'Cancel', hint: 'nothing is archived' },
        { value: true, label: 'Yes, archive', hint: 'reversible' },
      ],
      { defaultIndex: 0 },
    );
    if (!go) {
      log(`${c.dim('Cancelled — nothing was archived.')}`);
      return 0;
    }
  }

  const res = await picked.store.groomRun(parsed.request);
  if (!res.ok) {
    const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
    if (args.json) {
      log(JSON.stringify({ ok: false, op: 'run', archived: null, keys: [], error: String(msg) }, null, 2));
      return 1;
    }
    err(`${c.red('Error:')} ${msg}`);
    return 1;
  }
  if (args.json) {
    log(JSON.stringify({ ok: true, op: 'run', archived: res.archived, keys: res.keys }, null, 2));
    return 0;
  }
  log(`${c.green('✓')} archived ${c.cyan(String(res.archived))} lesson${res.archived === 1 ? '' : 's'} ${c.dim('(remote)')}`);
  return 0;
}
