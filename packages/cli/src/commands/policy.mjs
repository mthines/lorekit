// `lorekit policy <list|create|update|delete>` — manage saved retention rules.
//
//   policy list                                       list every saved policy
//   policy create --scope S --name N [conditions...]   save a new rule
//   policy update <id> [fields...]                     change a saved rule
//   policy delete <id> [--yes]                          delete the RULE only
//
// Server-side only — retention_policies has no local-store equivalent
// (matching groom/purge). `policy.create`/`update`/`delete` are catalog
// `cliExempt` (they are actions of THIS command, not their own subcommands),
// so only `policy.list` claims the `tool: 'memory.policy_list'`... no —
// `policy.list` claims `tool: 'policy.list'` in the registry; the other three
// verbs are dispatched here without a catalog tool binding of their own.
import { resolveProjectRoot } from '../shared/config.mjs';
import { loadControl, resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { log, err, c, select } from '../shared/util.mjs';
import { parseIntFlag } from '../shared/flags.mjs';

function pickRemote({ root, env, args }) {
  const { remoteDenied } = resolveDenies(root, { env });
  const { remote, connection } = resolveStores(root, { env, endpoint: args.endpoint, token: args.token });
  if (remoteDenied) return { error: `remote store is disabled by deny constraint (${remoteDenied.source})` };
  if (!remote.usable()) return { error: `remote store is not configured — ${remoteUnavailableReason(connection)}` };
  return { store: remote };
}

function formatPolicy(p) {
  const conditions = [];
  if (p.min_age_days != null) conditions.push(`min_age_days=${p.min_age_days}`);
  if (p.unseen_days != null) conditions.push(`unseen_days=${p.unseen_days}`);
  if (p.max_seen_count != null) conditions.push(`max_seen_count=${p.max_seen_count}`);
  if (p.max_read_count != null) conditions.push(`max_read_count=${p.max_read_count}`);
  if (p.max_opened_count != null) conditions.push(`max_opened_count=${p.max_opened_count}`);
  const mode = p.mode === 'auto' ? (p.enabled ? c.green('auto (enabled)') : c.dim('auto (disabled)')) : c.dim('review');
  return `${c.cyan(p.id)}  ${c.bold(p.name)}  ${c.dim(p.scope)}  ${mode}${conditions.length ? `  ${c.dim(conditions.join(', '))}` : ''}`;
}

async function list(args, store) {
  const res = await store.policyList();
  if (!res.ok) {
    const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
    if (args.json) { log(JSON.stringify({ ok: false, entries: [], error: String(msg) }, null, 2)); return 1; }
    err(`${c.red('Error:')} ${msg}`);
    return 1;
  }
  if (args.json) { log(JSON.stringify({ ok: true, entries: res.entries }, null, 2)); return 0; }
  if (res.entries.length === 0) { log(c.dim('No retention policies yet. Create one with `lorekit policy create`.')); return 0; }
  for (const p of res.entries) log(formatPolicy(p));
  return 0;
}

async function create(args, store) {
  if (!args.scope || !args.name) {
    err(`${c.red('Usage:')} lorekit policy create --scope <scope> --name <name> [--mode review|auto] [--enabled] [--min-age-days N] [--unseen-days N] [--max-seen-count N] [--max-read-count N] [--max-opened-count N]`);
    return 1;
  }
  const minAge = parseIntFlag(args['min-age-days'], 'min-age-days');
  if (minAge.error) { err(`${c.red('Error:')} ${minAge.error}`); return 1; }
  const unseen = parseIntFlag(args['unseen-days'], 'unseen-days');
  if (unseen.error) { err(`${c.red('Error:')} ${unseen.error}`); return 1; }
  const maxSeen = parseIntFlag(args['max-seen-count'], 'max-seen-count');
  if (maxSeen.error) { err(`${c.red('Error:')} ${maxSeen.error}`); return 1; }
  const maxRead = parseIntFlag(args['max-read-count'], 'max-read-count');
  if (maxRead.error) { err(`${c.red('Error:')} ${maxRead.error}`); return 1; }
  const maxOpened = parseIntFlag(args['max-opened-count'], 'max-opened-count');
  if (maxOpened.error) { err(`${c.red('Error:')} ${maxOpened.error}`); return 1; }
  if (args.mode !== undefined && args.mode !== 'review' && args.mode !== 'auto') {
    err(`${c.red('Error:')} --mode must be "review" or "auto"`);
    return 1;
  }

  const res = await store.policyCreate({
    scope: args.scope,
    name: args.name,
    mode: args.mode,
    enabled: args.enabled ? true : undefined,
    min_age_days: minAge.value,
    unseen_days: unseen.value,
    max_seen_count: maxSeen.value,
    max_read_count: maxRead.value,
    max_opened_count: maxOpened.value,
  });
  if (!res.ok) {
    const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
    if (args.json) { log(JSON.stringify({ ok: false, policy: null, error: String(msg) }, null, 2)); return 1; }
    err(`${c.red('Error:')} ${msg}`);
    return 1;
  }
  if (args.json) { log(JSON.stringify({ ok: true, policy: res.policy }, null, 2)); return 0; }
  log(`${c.green('✓')} created policy ${formatPolicy(res.policy)}`);
  return 0;
}

async function update(args, store) {
  const id = args._[2];
  if (!id) {
    err(`${c.red('Usage:')} lorekit policy update <id> [--name N] [--mode review|auto] [--enabled|--disabled] [--min-age-days N] [--unseen-days N] [--max-seen-count N] [--max-read-count N] [--max-opened-count N]`);
    return 1;
  }
  if (args.mode !== undefined && args.mode !== 'review' && args.mode !== 'auto') {
    err(`${c.red('Error:')} --mode must be "review" or "auto"`);
    return 1;
  }

  const patch = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.mode !== undefined) patch.mode = args.mode;
  if (args.enabled) patch.enabled = true;
  if (args.disabled) patch.enabled = false;
  for (const [flag, clearFlag, field] of [
    ['min-age-days', 'clear-min-age-days', 'min_age_days'],
    ['unseen-days', 'clear-unseen-days', 'unseen_days'],
    ['max-seen-count', 'clear-max-seen-count', 'max_seen_count'],
    ['max-read-count', 'clear-max-read-count', 'max_read_count'],
    ['max-opened-count', 'clear-max-opened-count', 'max_opened_count'],
  ]) {
    if (args[clearFlag]) { patch[field] = null; continue; }
    if (args[flag] === undefined) continue;
    const parsed = parseIntFlag(args[flag], flag);
    if (parsed.error) { err(`${c.red('Error:')} ${parsed.error}`); return 1; }
    patch[field] = parsed.value;
  }
  if (Object.keys(patch).length === 0) {
    err(`${c.red('Error:')} at least one field to update is required`);
    return 1;
  }

  const res = await store.policyUpdate(id, patch);
  if (!res.ok) {
    const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
    if (args.json) { log(JSON.stringify({ ok: false, policy: null, error: String(msg) }, null, 2)); return 1; }
    err(`${c.red('Error:')} ${msg}${res.httpStatus === 404 ? ` — no policy found for id ${id}` : ''}`);
    return 1;
  }
  if (args.json) { log(JSON.stringify({ ok: true, policy: res.policy }, null, 2)); return 0; }
  log(`${c.green('✓')} updated policy ${formatPolicy(res.policy)}`);
  return 0;
}

async function del(args, store) {
  const id = args._[2];
  if (!id) {
    err(`${c.red('Usage:')} lorekit policy delete <id>`);
    return 1;
  }
  const decision = args.yes ? 'proceed' : (args.json || !process.stdin.isTTY) ? 'refuse' : 'prompt';
  if (decision === 'refuse') {
    err(`${c.red('Refusing:')} deletes the policy with no terminal to confirm. Re-run with ${c.cyan('--yes')}.`);
    return 1;
  }
  if (decision === 'prompt') {
    const go = await select(
      `${c.bold('Delete policy')} ${id}? The lessons it matched are untouched.`,
      [
        { value: false, label: 'Cancel' },
        { value: true, label: 'Yes, delete' },
      ],
      { defaultIndex: 0 },
    );
    if (!go) { log(c.dim('Cancelled.')); return 0; }
  }

  const res = await store.policyDelete(id);
  if (!res.ok) {
    const msg = res.error?.message ?? res.error ?? res.networkError ?? 'the server rejected the request';
    if (args.json) { log(JSON.stringify({ ok: false, deleted: false, error: String(msg) }, null, 2)); return 1; }
    err(`${c.red('Error:')} ${msg}${res.httpStatus === 404 ? ` — no policy found for id ${id}` : ''}`);
    return 1;
  }
  if (args.json) { log(JSON.stringify({ ok: true, deleted: true }, null, 2)); return 0; }
  log(`${c.green('✓')} deleted policy ${c.cyan(id)}`);
  return 0;
}

export async function policy(args) {
  const root = resolveProjectRoot(args.dir);
  const env = process.env;
  loadControl(root, { env });

  const picked = pickRemote({ root, env, args });
  if (picked.error) {
    err(`${c.red('Error:')} ${picked.error}`);
    return 1;
  }

  const sub = args._[1];
  if (sub === 'list') return list(args, picked.store);
  if (sub === 'create') return create(args, picked.store);
  if (sub === 'update') return update(args, picked.store);
  if (sub === 'delete') return del(args, picked.store);

  err(`${c.red('Usage:')} lorekit policy <list|create|update|delete> [options]`);
  return 1;
}
