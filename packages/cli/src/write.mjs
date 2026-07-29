// `lorekit write <scope> <key> [value]` — create or update a memory from the CLI.
//
// Two positional shapes are accepted:
//   write <scope> <key> [value]       — classic two-positional form
//   write <scope::key> [value]        — combined shorthand (the same format `list`
//                                       prints, so you can copy-paste a key directly)
//
// When no value is supplied as a positional or via --value, the command reads
// the full stdin (useful for piping). In all cases the value is required — an
// empty string produces a usage error (prefer `lorekit delete` to remove a key).
//
// Optional write-metadata flags mirror the hosted `memory.write` parameters:
//   --tags <a,b,c>         Comma-separated tag list (default: no tags)
//   --source-agent <name>  Which agent recorded this lesson (default: none)
//   --trigger <slug>       What prompted the write (default: none)
//   --ttl-days <n>         Days until the memory auto-expires (1–365)
//   --org <slug>           Write to this org (remote only)
//
// Store targeting (default: remote if configured, else local):
//   --remote               Force write to the remote store
//   --local                Force write to the local offline store
//
// The command writes to ONE store at a time (unlike the read commands that show
// both). Dual-write would silently create a divergence on subsequent `diff`.
//
// Output: a confirmation line (human) or a JSON object (--json) with the
// resolved scope, key, store written, and a boolean `inserted` (true = created,
// false = updated) when the remote reports it.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { log, err, heading, status, c } from './util.mjs';

// Parse `scope::key` from a single string, returning { scope, key } or null.
function parseScopeKey(s) {
  const idx = s.indexOf('::');
  if (idx === -1) return null;
  const scope = s.slice(0, idx).trim();
  const key = s.slice(idx + 2).trim();
  if (!scope || !key) return null;
  return { scope, key };
}

// Read all of stdin to a string. Resolves to '' when stdin IS a TTY (no pipe).
function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trimEnd()));
    process.stdin.resume();
  });
}

export async function write(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // ── Parse positionals: two forms ──────────────────────────────────────────
  // Form A: `write scope key [value]`   → _[1]=scope, _[2]=key, _[3]=value?
  // Form B: `write scope::key [value]`  → _[1]='scope::key', _[2]=value?
  let scope, key, positionalValue;

  const first = typeof args._[1] === 'string' ? args._[1] : '';
  const parsed = parseScopeKey(first);

  if (parsed) {
    // Form B: combined scope::key
    scope = parsed.scope;
    key = parsed.key;
    positionalValue = typeof args._[2] === 'string' ? args._[2] : undefined;
  } else {
    // Form A: separate scope and key
    scope = first;
    key = typeof args._[2] === 'string' ? args._[2] : '';
    positionalValue = typeof args._[3] === 'string' ? args._[3] : undefined;
  }

  if (!scope || !key) {
    err(`${c.red('Usage:')} lorekit write <scope> <key> [value] [options]`);
    err(`       lorekit write <scope::key> [value] [options]`);
    err(`Both a scope and a key are required. Run ${c.cyan('lorekit write --help')} for options.`);
    return 1;
  }

  // ── Resolve value: flag → positional → stdin ───────────────────────────────
  let value;
  if (typeof args.value === 'string') {
    value = args.value;
  } else if (positionalValue !== undefined) {
    value = positionalValue;
  } else {
    value = await readStdin();
  }

  if (!value) {
    err(`${c.red('Error:')} a non-empty value is required`);
    err(`Pipe a value via stdin, pass it as a positional, or use --value <text>.`);
    err(`To remove a key, use ${c.cyan('lorekit delete <scope> <key>')}.`);
    return 1;
  }

  // ── Parse optional metadata flags ─────────────────────────────────────────
  const tags = args.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [];
  const sourceAgent = typeof args['source-agent'] === 'string' ? args['source-agent'] : undefined;
  const trigger = typeof args.trigger === 'string' ? args.trigger : undefined;
  const ttlDays = args['ttl-days'] ? Number(args['ttl-days']) : undefined;
  const orgSlug = typeof args.org === 'string' ? args.org : undefined;

  // ── Resolve deny constraints ───────────────────────────────────────────────
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  // ── Resolve stores and pick the target ────────────────────────────────────
  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  const forceRemote = Boolean(args.remote);
  const forceLocal = Boolean(args.local);
  const remoteUsable = !remoteDenied && remote.usable();

  if (forceRemote && forceLocal) {
    err(`${c.red('Error:')} --remote and --local are mutually exclusive`);
    return 1;
  }

  let targetStore, storeName;

  if (forceRemote) {
    if (remoteDenied) {
      err(`${c.red('Error:')} remote store is disabled by deny constraint (${remoteDenied.source})`);
      return 1;
    }
    if (!remote.usable()) {
      err(`${c.red('Error:')} remote store is not configured — ${remoteUnavailableReason(connection)}`);
      return 1;
    }
    targetStore = remote;
    storeName = 'remote';
  } else if (forceLocal) {
    if (localDenied) {
      err(`${c.red('Error:')} local store is disabled by deny constraint (${localDenied.source})`);
      return 1;
    }
    targetStore = local;
    storeName = 'local';
  } else if (remoteUsable) {
    targetStore = remote;
    storeName = 'remote';
  } else if (!localDenied) {
    targetStore = local;
    storeName = 'local';
  } else {
    err(`${c.red('Error:')} no writable store available`);
    err(`Remote: ${remoteUnavailableReason(connection)}`);
    if (localDenied) err(`Local:  disabled by deny constraint (${localDenied.source})`);
    return 1;
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  const writeArgs = {
    scope,
    key,
    value: String(value),
    ...(tags.length ? { tags } : {}),
    ...(sourceAgent ? { source_agent: sourceAgent } : {}),
    ...(trigger ? { trigger } : {}),
    ...(ttlDays ? { ttl_days: ttlDays } : {}),
    ...(orgSlug ? { org: orgSlug } : {}),
  };

  let result;
  try {
    result = await targetStore.write(writeArgs);
  } catch (e) {
    err(`${c.red('Error:')} ${(e && e.message) || String(e)}`);
    return 1;
  }

  if (!result || result.ok === false) {
    const detail = result && result.error ? result.error : 'unknown error';
    err(`${c.red('Error writing to')} ${storeName} store: ${detail}`);
    return 1;
  }

  // `inserted` is additive from the remote (memory_write RPC 00011). Local store
  // returns { ok, entry } with no explicit field; treat absence as unknown.
  const inserted = result.inserted ?? null;

  if (args.json) {
    log(JSON.stringify({
      scope,
      key,
      store: storeName,
      inserted,
      value: String(value),
      tags,
      source_agent: sourceAgent || null,
      trigger: trigger || null,
    }, null, 2));
  } else {
    const verb = inserted === true ? 'Created' : inserted === false ? 'Updated' : 'Written';
    heading('LoreKit memory written');
    log(`  ${c.dim('store')}  ${storeName}`);
    log(`  ${c.dim('scope')}  ${scope}`);
    log(`  ${c.dim('key')}    ${key}`);
    if (tags.length) log(`  ${c.dim('tags')}   ${tags.join(', ')}`);
    status('pass', verb, `${scope}::${key}`);
    log('');
  }

  return {
    exitCode: 0,
    'lorekit.cli.write.store': storeName,
    'lorekit.cli.write.inserted': inserted,
    'lorekit.cli.write.has_tags': tags.length > 0,
    'lorekit.cli.write.has_ttl': Boolean(ttlDays),
  };
}
