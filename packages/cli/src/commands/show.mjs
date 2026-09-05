// `lorekit show <scope::key>` — inspect ONE lesson in full: its complete
// (untruncated) value, scope, key, updated timestamp, tags, and which store(s)
// it lives in. When the same scope::key exists in BOTH the offline and remote
// stores — possibly with different values — both are shown and the divergence is
// flagged.
//
// Positional shapes accepted (see `resolveScopeKeyArgs` in `lessons-pure.mjs`
// for the one shared, scope-validity-gated disambiguation rule):
//   show <scope::key>      — canonical form (the same format `list` prints, so
//                            you can copy-paste a key directly from list output)
//   show <scope> <key>     — the explicit two-positional form
//   show --scope <s> --key <k>
//                          — flags win; an explicit override that skips the `::`
//                            split (the shorthand already carries a namespaced
//                            key, since the split lands at the first valid-scope
//                            prefix — see `resolveScopeArg`)
//   show <s1::k1> <s2::k2> [...]
//                          — multi-ref form: two or more positionals that EACH
//                            parse as a complete `<scope>::<key>` reference (see
//                            `isMultiRefForm` below). Batches through each
//                            store's `readMany`, one round-trip to the remote
//                            store rather than one request per ref.
//
// Uses each store's real `read({scope, key})` method (both stores expose it),
// not a filtered `list` — a single-record lookup is what `read` is for, and it
// already hides archived entries. Graceful by design (mirrors `list`/`search`):
// an unconfigured remote is a short note, never an error. Read-only. Human-facing,
// so the bin wraps it in `traceCommand`.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import {
  normalizeEntry,
  shortDate,
  describeError,
  recordsDiverge,
  resolveScopeArg,
  resolveScopeKeyArgs,
  isScopeString,
  scopeIssue,
} from '../shared/lessons-view.mjs';
import { resolveAppBase } from '../shared/deeplink-pure.mjs';
import { emitLink } from './link.mjs';
import { log, err, heading, status, c } from '../shared/util.mjs';

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

// Is this a multi-ref invocation? Two or more positionals, no `--scope`/`--key`
// override (a flag is an explicit single-ref assertion — see
// `resolveScopeKeyArgs`), and EVERY positional parses as a complete
// `<scope>::<key>` reference via `resolveScopeArg`.
//
// This is what keeps the existing `show <scope> <key>` two-positional form
// unambiguous: its first positional is a BARE scope with no `::`, so
// `resolveScopeArg` reports it with a null key and the predicate below is
// false — the single-ref path runs unchanged, exactly as `show <scope::key>`
// (one positional) always has.
function isMultiRefForm(positionals, args) {
  if (positionals.length < 2 || args.scope || args.key) return false;
  return positionals.every((p) => resolveScopeArg(p, isScopeString).key !== null);
}

// Batch-read `refs` ({scope,key}[]) from one store via its `readMany`, and
// project the result back into ONE `{available, found, record, error}` slot
// per ref, in the SAME order the refs were given — mirroring what `readOne`
// answers for a single ref, so the per-ref renderer and `--json` builder don't
// need to know whether they are looking at a single read or a batch one.
//
// A transport-level failure (throw, or `{ ok:false }`) degrades EVERY ref in
// the batch to the same error note, exactly as a per-store outage would if
// each ref were read one at a time — a batch call doesn't get to fail more
// silently than the single-ref path it replaces.
async function readManyFrom(store, refs) {
  let res;
  try {
    res = await store.readMany(refs);
  } catch (e) {
    const msg = (e && e.message) || 'error';
    return refs.map(() => ({ available: true, found: false, record: null, error: msg }));
  }
  if (!res || res.ok === false) {
    const msg = describeError(res);
    return refs.map(() => ({ available: true, found: false, record: null, error: msg }));
  }
  const byRef = new Map();
  for (const entry of res.entries || []) {
    const record = normalizeEntry(entry);
    byRef.set(`${record.scope}::${record.key}`, record);
  }
  return refs.map(({ scope, key }) => {
    const record = byRef.get(`${scope}::${key}`) || null;
    return { available: true, found: Boolean(record), record, error: null };
  });
}

// The multi-ref path: resolve every ref against both stores (one `readMany`
// round-trip per store, not one per ref) and report each in request order.
async function showRefs(refs, args, root, env) {
  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const offlineList = localDenied
    ? refs.map(() => ({ available: false, reason: `disabled by deny constraint (${localDenied.source})` }))
    : await readManyFrom(local, refs);

  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteList = remoteDenied
    ? refs.map(() => ({ available: false, reason: `disabled by deny constraint (${remoteDenied.source})` }))
    : remoteAvailable
      ? await readManyFrom(remote, refs)
      : refs.map(() => ({ available: false, reason: remoteUnavailableReason(connection) }));

  const results = refs.map(({ scope, key }, i) => {
    const offline = offlineList[i];
    const remote_ = remoteList[i];
    const foundOffline = Boolean(offline.available && offline.found);
    const foundRemote = Boolean(remote_.available && remote_.found);
    const diverged = foundOffline && foundRemote && recordsDiverge(offline.record, remote_.record);
    const found = foundOffline || foundRemote;
    return { scope, key, offline, remote_, foundOffline, foundRemote, diverged, found };
  });

  if (args.json) {
    log(JSON.stringify({
      results: results.map((r) => buildJson({
        scope: r.scope, key: r.key, offline: r.offline, remote_: r.remote_, diverged: r.diverged,
      })),
    }, null, 2));
  } else {
    heading('LoreKit memory');
    log(`  ${c.dim(`${results.length} references`)}`);
    for (const r of results) {
      log('');
      log(`  ${c.cyan(`${r.scope}::${r.key}`)}`);
      renderRecordSection('Offline', r.offline);
      renderRecordSection('Remote', r.remote_, remoteAvailable ? connection.endpoint : undefined);
      if (r.diverged) status('warn', 'divergence', 'the offline and remote values differ');
      if (!r.found) log(`    ${c.dim(`no memory found for ${r.scope}::${r.key} in the readable store(s)`)}`);
    }
    log('');
  }

  const foundCount = results.filter((r) => r.found).length;
  // Bounded, non-PII telemetry — counts only, never a scope or key string.
  return {
    exitCode: foundCount === results.length ? 0 : 1,
    'lorekit.cli.show.ref_count': results.length,
    'lorekit.cli.show.found_count': foundCount,
    'lorekit.cli.show.diverged_count': results.filter((r) => r.diverged).length,
  };
}

export async function show(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // Positional shapes (all resolved by the shared, validity-gated parser):
  //   show <scope::key>            — canonical shorthand, mirrors `list` output
  //   show <scope> <key>           — explicit two-positional form
  //   show --scope <s> --key <k>   — flags win; an explicit override that skips
  //                                  the `::` split (the shorthand handles a
  //                                  namespaced key on its own now)
  const positionals = args._.slice(1);

  if (isMultiRefForm(positionals, args)) {
    const refs = positionals.map((p) => resolveScopeArg(p, isScopeString));
    return showRefs(refs, args, root, env);
  }

  const { scope, key, consumed } = resolveScopeKeyArgs(positionals, {
    scope: args.scope,
    key: args.key,
  });
  // Scope validity is checked FIRST, for the same reason as in `write`: a bad
  // scope is the root cause, and "a key is required" is downstream noise.
  const badScope = scope ? scopeIssue(scope) : null;
  if (badScope) {
    err(`${c.red('Error:')} invalid scope ${c.cyan(scope)} — ${badScope}`);
    err(`Valid scopes: global | project::<name> | repo::<owner>/<name> | branch::<owner>/<name>::<branch>`);
    err(`Run ${c.cyan('lorekit show --help')} for options.`);
    return 1;
  }
  if (!scope || !key) {
    err(`${c.red('Usage:')} lorekit show <scope::key> [--json]`);
    err(`       lorekit show <scope> <key> [--json]`);
    err(`Both a scope and a key are required. Run ${c.cyan('lorekit show --help')} for options.`);
    return 1;
  }
  // `show` consumes every positional it is given — unlike `write`, it has no
  // trailing value — so a leftover one means the caller's mental model differs
  // from what was parsed. Say so instead of silently reading a different key.
  if (positionals.length > consumed) {
    err(`${c.red('Error:')} unexpected argument ${c.cyan(positionals[consumed])}`);
    err(`Parsed scope ${c.cyan(scope)} and key ${c.cyan(key)} from the arguments before it.`);
    err(`Run ${c.cyan('lorekit show --help')} for options.`);
    return 1;
  }

  // `--link` short-circuits: print the deep link that opens THIS lesson's detail
  // sheet (`?scope=…&lesson=…`) for the current args, without touching a store.
  if (args.link) {
    const base = resolveAppBase({ base: args.base, env });
    return emitLink({ params: { scope, lesson: { scope, key } }, base, json: args.json });
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
    heading('LoreKit memory');
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
      log(`  ${c.dim(`no memory found for ${scope}::${key} in the readable store(s)`)}`);
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
