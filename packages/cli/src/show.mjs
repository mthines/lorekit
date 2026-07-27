// `lorekit show <scope> <key>` — inspect ONE lesson in full: its complete
// (untruncated) value, scope, key, updated timestamp, tags, and which store(s)
// it lives in. When the same scope::key exists in BOTH the offline and remote
// stores — possibly with different values — both are shown and the divergence is
// flagged.
//
// Uses each store's real `read({scope, key})` method (both stores expose it),
// not a filtered `list` — a single-record lookup is what `read` is for, and it
// already hides archived entries. Graceful by design (mirrors `list`/`search`):
// an unconfigured remote is a short note, never an error. Read-only. Human-facing,
// so the bin wraps it in `traceCommand`.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { normalizeEntry, shortDate, describeError, recordsDiverge } from './lessons-view.mjs';
import { log, err, heading, status, c } from './util.mjs';

// Read one scope::key from a store, normalizing the result into a small,
// uniform shape: { available:true, found, record } on success, or
// { available:true, found:false, error } when the read itself failed (network /
// server). A per-store read failure is captured, never thrown, so one bad store
// never aborts the other section.
async function readOne(store, scope, key) {
  let res;
  try {
    res = await store.read({ scope, key });
  } catch (e) {
    return { available: true, found: false, record: null, error: (e && e.message) || 'error' };
  }
  if (!res || res.ok === false) {
    return { available: true, found: false, record: null, error: describeError(res) };
  }
  const record = res.entry ? normalizeEntry(res.entry) : null;
  return { available: true, found: Boolean(record), record, error: null };
}

export async function show(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // Both positionals are required: `show <scope> <key>`.
  const scope = typeof args._[1] === 'string' ? args._[1] : '';
  const key = typeof args._[2] === 'string' ? args._[2] : '';
  if (!scope || !key) {
    err(`${c.red('Usage:')} lorekit show <scope> <key> [--json]`);
    err(`Both a scope and a key are required. Run ${c.cyan('lorekit show --help')} for options.`);
    return 1;
  }

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // Deny-wins section suppression, identical to `list`/`search`.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const offline = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : await readOne(local, scope, key);

  const remoteAvailable = !remoteDenied && remote.usable();
  const remote_ = remoteDenied
    ? { available: false, reason: `disabled by deny constraint (${remoteDenied.source})` }
    : remoteAvailable
      ? await readOne(remote, scope, key)
      : { available: false, reason: remoteUnavailableReason(connection) };

  const foundOffline = Boolean(offline.available && offline.found);
  const foundRemote = Boolean(remote_.available && remote_.found);
  const diverged = foundOffline && foundRemote && recordsDiverge(offline.record, remote_.record);
  // "Not found" is only definitive across the stores we could actually consult.
  const found = foundOffline || foundRemote;

  if (args.json) {
    log(JSON.stringify(buildJson({ scope, key, offline, remote_, diverged }), null, 2));
  } else {
    heading('LoreKit lesson');
    log(`  scope:  ${c.dim(scope)}`);
    log(`  key:    ${c.dim(key)}`);

    renderRecordSection('Offline', offline);
    renderRecordSection(
      'Remote',
      remote_,
      remoteAvailable ? connection.endpoint : undefined,
    );

    if (diverged) {
      log('');
      status('warn', 'divergence', 'the offline and remote values differ');
    }
    if (!found) {
      log('');
      log(`  ${c.dim(`no lesson found for ${scope}::${key} in the readable store(s)`)}`);
    }
    log('');
  }

  // Bounded, non-PII telemetry — booleans only, never the scope string or key.
  return {
    exitCode: found ? 0 : 1,
    'lorekit.cli.show.found_offline': foundOffline,
    'lorekit.cli.show.found_remote': foundRemote,
    'lorekit.cli.show.diverged': diverged,
  };
}

// Render one store's slot: an unavailable note, a "no such key here" line, or the
// full record (untruncated value).
function renderRecordSection(title, section, subtitle) {
  heading(title);
  if (subtitle) log(`  ${c.dim(subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }
  if (section.error) {
    status('warn', 'unreadable', section.error);
    return;
  }
  if (!section.found) {
    log(`  ${c.dim('no such key in this store')}`);
    return;
  }

  const e = section.record;
  if (e.updated) log(`  ${c.dim('updated')} ${shortDate(e.updated)}`);
  if (e.tags && e.tags.length) log(`  ${c.dim('tags')}    ${e.tags.join(', ')}`);
  log(`  ${c.dim('value')}`);
  // The full, untruncated body — indented, line by line, so multi-line lessons
  // read as written.
  for (const line of String(e.value ?? '').split('\n')) {
    log(`    ${line}`);
  }
}

// The `--json` payload: the full normalized record(s) plus which store each came
// from and whether they diverge.
function buildJson({ scope, key, offline, remote_, diverged }) {
  return {
    scope,
    key,
    offline: recordJson(offline),
    remote: recordJson(remote_),
    diverged,
  };
}

function recordJson(section) {
  if (!section.available) {
    return { available: false, reason: section.reason, found: false, record: null };
  }
  return {
    available: true,
    found: Boolean(section.found),
    record: section.record || null,
    ...(section.error ? { error: section.error } : {}),
  };
}
