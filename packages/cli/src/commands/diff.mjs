// `lorekit diff` — compare the offline (local two-tier) store against the remote
// (hosted MCP) store for the current directory's scopes, and report where they
// diverge in three groups, grouped by scope:
//   • local-only   — key present offline, absent remote;
//   • remote-only   — absent offline, present remote;
//   • conflicting   — same scope::key in both, but the value/tags differ.
//
// A diff is only meaningful when BOTH stores are readable. If either is
// unavailable — the remote unconfigured, a `LOREKIT_DENY` ceiling, etc. — a diff
// is impossible, so `diff` prints a clear note explaining which store is missing
// and exits 0 (never a crash). Read-only. Human-facing, so the bin wraps it in
// `traceCommand`.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { deriveScope } from '../shared/scope.mjs';
import { resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { scopeList, gather, diffGroups, preview, shortDate } from '../shared/lessons-view.mjs';
import { log, heading, status, c } from '../shared/util.mjs';

export async function diff(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  const scopeInfo = deriveScope(root);
  // Default to every applicable scope; `--scope <s>` narrows to one.
  const scopes = args.scope && typeof args.scope === 'string' ? [args.scope] : scopeList(scopeInfo);

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // Deny-wins section suppression, identical to the other read commands.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const localAvailable = !localDenied;
  const remoteAvailable = !remoteDenied && remote.usable();

  // Explain, per store, why it is not comparable (used for the not-comparable
  // note below). A store that IS available reports `null`.
  const offlineReason = localDenied
    ? `disabled by deny constraint (${localDenied.source})`
    : null;
  const remoteReason = remoteDenied
    ? `disabled by deny constraint (${remoteDenied.source})`
    : remoteAvailable
      ? null
      : remoteUnavailableReason(connection);

  const comparable = localAvailable && remoteAvailable;

  // Only gather (and diff) when both stores are readable — a one-sided read
  // cannot distinguish "only in the other store" from "the other store is
  // simply unreachable".
  const result = comparable ? diffGroups(await gather(local, scopes), await gather(remote, scopes)) : null;

  if (args.json) {
    log(JSON.stringify(buildJson({ root, scopes, comparable, offlineReason, remoteReason, result }), null, 2));
  } else if (!comparable) {
    renderNotComparable({ root, scopes, offlineReason, remoteReason });
  } else {
    renderDiff({ root, scopes, connection, remoteAvailable, result });
  }

  // Bounded, non-PII telemetry extras — counts + booleans, never a scope
  // string, key, path, or token.
  const totals = result ? result.totals : { localOnly: 0, remoteOnly: 0, conflicting: 0 };
  return {
    exitCode: 0,
    'lorekit.cli.diff.scope_count': scopes.length,
    'lorekit.cli.diff.comparable': comparable,
    'lorekit.cli.diff.local_only': totals.localOnly,
    'lorekit.cli.diff.remote_only': totals.remoteOnly,
    'lorekit.cli.diff.conflicting': totals.conflicting,
  };
}

// The not-comparable note: which store(s) are missing, and why a diff needs both.
function renderNotComparable({ root, scopes, offlineReason, remoteReason }) {
  heading('LoreKit diff');
  log(`  project: ${c.dim(root)}`);
  log(`  scopes:  ${scopes.join('  →  ')}`);
  log('');
  if (offlineReason) status('warn', 'offline unavailable', offlineReason);
  if (remoteReason) status('warn', 'remote unavailable', remoteReason);
  log(
    `  ${c.dim('a diff compares the offline and remote stores side by side — both must be readable.')}`,
  );
  log('');
}

// The real diff: three grouped sections. Each section groups the divergent keys
// by scope; a scope with nothing in a section is omitted from it.
function renderDiff({ root, scopes, connection, remoteAvailable, result }) {
  heading('LoreKit diff');
  log(`  project: ${c.dim(root)}`);
  log(`  scopes:  ${scopes.join('  →  ')}`);
  if (remoteAvailable) log(`  remote:  ${c.dim(connection.endpoint)}`);

  const { groups, totals } = result;

  // Surface any per-scope read errors up front — a scope that failed to read on
  // one side can't be diffed, and its keys are neither "only" nor "conflicting".
  const errored = groups.filter((g) => g.error);
  if (errored.length) {
    heading('Unreadable scopes');
    for (const g of errored) log(`  ${c.bold(g.scope)}  ${c.yellow('!')} ${c.dim(g.error)}`);
  }

  renderSet('Local-only', 'present offline, absent remote', groups, (g) => g.localOnly);
  renderSet('Remote-only', 'absent offline, present remote', groups, (g) => g.remoteOnly);
  renderConflicts(groups);

  if (totals.localOnly + totals.remoteOnly + totals.conflicting === 0 && !errored.length) {
    log('');
    log(`  ${c.dim('the offline and remote stores are in sync for the applicable scopes')}`);
  }
  log('');
}

// One "only in store X" section: group its entries by scope, key + preview per
// entry. Skipped entirely when no scope has any entry in it.
function renderSet(title, subtitle, groups, pick) {
  const present = groups.filter((g) => pick(g).length);
  if (!present.length) return;
  heading(title);
  log(`  ${c.dim(subtitle)}`);
  for (const g of present) {
    log(`  ${c.bold(g.scope)}`);
    for (const e of pick(g)) {
      const when = e.updated ? `  ${c.dim(`(updated ${shortDate(e.updated)})`)}` : '';
      log(`    ${c.cyan('•')} ${g.scope}::${e.key}${when}`);
      if (e.value) log(`      ${c.dim(preview(e.value))}`);
    }
  }
}

// The conflicting section: same key in both stores, differing value/tags. Shows
// a short preview of each side so the divergence is visible at a glance.
function renderConflicts(groups) {
  const present = groups.filter((g) => g.conflicting.length);
  if (!present.length) return;
  heading('Conflicting');
  log(`  ${c.dim('same key in both stores, but the value or tags differ')}`);
  for (const g of present) {
    log(`  ${c.bold(g.scope)}`);
    for (const conflict of g.conflicting) {
      log(`    ${c.yellow('•')} ${g.scope}::${conflict.key}`);
      log(`      ${c.dim('offline')} ${preview(conflict.local.value)}`);
      log(`      ${c.dim('remote ')} ${preview(conflict.remote.value)}`);
    }
  }
}

// The `--json` payload. When not comparable:
//   { root, scopes, comparable:false, offline:{available,reason}, remote:{...} }
// When comparable:
//   { root, scopes, comparable:true, totals, groups:[{ scope, localOnly,
//     remoteOnly, conflicting, error }] } — the exact shape `diffGroups` returns.
function buildJson({ root, scopes, comparable, offlineReason, remoteReason, result }) {
  if (!comparable) {
    return {
      root,
      scopes,
      comparable: false,
      offline: offlineReason ? { available: false, reason: offlineReason } : { available: true },
      remote: remoteReason ? { available: false, reason: remoteReason } : { available: true },
    };
  }
  return {
    root,
    scopes,
    comparable: true,
    totals: result.totals,
    groups: result.groups,
  };
}
