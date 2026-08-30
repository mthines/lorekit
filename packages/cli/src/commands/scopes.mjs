// `lorekit scopes` — a STORE-WIDE inventory of every distinct scope that holds
// lessons, with a per-scope lesson count, in the same Offline / Remote split as
// the other read commands.
//
// The key difference from `list` / `search` / `stats` / `diff` / `tree`: those
// are all cwd-scoped — they only look at the scopes that resolve for the current
// directory (project / branch / repo / global). `scopes` ignores the current
// directory entirely and enumerates EVERY scope present in the store, so a user
// can see all the scopes they have lessons in, anywhere.
//
// Offline enumeration is AUTHORITATIVE: it walks the local two-tier store and
// reads each lesson file's frontmatter `scope` string directly — never reverse-
// mapping the on-disk directory layout, which is lossy for `project::{name}`
// (stored by basename only) — so every scope is reconstructed exactly.
//
// Remote enumeration is EXACT too: `RemoteStore.listScopes()` calls
// `GET /memories/scopes`, which aggregates one row per scope in Postgres (never
// a truncatable `select('scope')` + client-side dedupe), so both sections are
// real inventories rendered through the same pure helpers. A denied,
// unconfigured, unreachable, or erroring remote still degrades to a short,
// accurate note at exit 0 — never a throw.
//
// Graceful, read-only, human-facing (the bin wraps it in `traceCommand`).
// `LOREKIT_DENY` suppresses a section; `--scope <s>` filters the inventory to
// scopes whose string contains that substring; `--json` emits `{ offline,
// remote }`.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { summarizeScopeInventory, filterScopeInventory, describeError } from '../shared/lessons-view.mjs';
import { log, heading, status, c } from '../shared/util.mjs';

export async function scopes(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // `--scope <s>` is a substring filter over the inventory (NOT a single-scope
  // selector like the cwd-scoped commands — an inventory of one scope would be
  // pointless). Absent → the full inventory.
  const filter = args.scope && typeof args.scope === 'string' ? args.scope : null;

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // Deny-wins section suppression, identical to `list` / `stats` / `diff`.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  // Offline: the authoritative store-wide enumeration.
  let offlineSection;
  if (localDenied) {
    offlineSection = { available: false, reason: `disabled by deny constraint (${localDenied.source})` };
  } else {
    const inventory = filterScopeInventory(await local.listScopes(), filter);
    offlineSection = { available: true, ...summarizeScopeInventory(inventory) };
  }

  // Remote: the hosted enumeration, via `GET /memories/scopes`. Precedence is
  // unchanged from the other read commands — deny first, then connectivity, then
  // the call itself. A failed call degrades to the same bounded, non-PII
  // `describeError` note a failed `list()` gets (network error / HTTP status),
  // never a throw and never a faked inventory.
  let remoteSection;
  if (remoteDenied) {
    remoteSection = { available: false, reason: `disabled by deny constraint (${remoteDenied.source})` };
  } else if (!remote.usable()) {
    remoteSection = { available: false, reason: remoteUnavailableReason(connection) };
  } else {
    const res = await remote.listScopes();
    remoteSection = res.ok
      ? { available: true, ...summarizeScopeInventory(filterScopeInventory(res.scopes, filter)) }
      : { available: false, reason: describeError(res) };
  }

  if (args.json) {
    log(JSON.stringify(buildJson({ root, filter, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit scopes');
    log(`  store: ${c.dim(root)}`);
    if (filter) log(`  filter: ${c.dim(filter)}`);
    renderScopesSection({ title: 'Offline' }, offlineSection);
    renderScopesSection(
      { title: 'Remote', subtitle: remote.usable() ? connection.endpoint : undefined },
      remoteSection,
    );
    log('');
  }

  // Bounded, non-PII telemetry extras (counts + booleans) — never a scope
  // string, path, or token. `remote_available` now reflects whether the hosted
  // enumeration actually answered; the remote counts mirror the offline pair.
  return {
    exitCode: 0,
    'lorekit.cli.scopes.offline_scope_count': offlineSection.available ? offlineSection.scopes.length : 0,
    'lorekit.cli.scopes.offline_total': offlineSection.available ? offlineSection.total : 0,
    'lorekit.cli.scopes.filtered': Boolean(filter),
    'lorekit.cli.scopes.remote_scope_count': remoteSection.available ? remoteSection.scopes.length : 0,
    'lorekit.cli.scopes.remote_total': remoteSection.available ? remoteSection.total : 0,
    'lorekit.cli.scopes.remote_available': remoteSection.available,
  };
}

// Render one store's inventory: an unavailable note, or a right-aligned
// `scope   count` table plus a `total` line noting the scope count.
function renderScopesSection(header, section) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  if (!section.scopes.length) {
    log(`  ${c.dim('no scopes found — the store holds no memories')}`);
    return;
  }

  const width = Math.max(0, ...section.scopes.map((s) => String(s.scope).length));
  for (const s of section.scopes) {
    log(`  ${c.bold(String(s.scope).padEnd(width))}  ${s.count}`);
  }
  const n = section.scopes.length;
  log(
    `  ${c.dim('total'.padEnd(width))}  ${c.bold(String(section.total))}  ` +
      `${c.dim(`(${n} scope${n === 1 ? '' : 's'})`)}`,
  );
}

// The `--json` payload: `{ root, filter, offline, remote }` — each store a
// `{ available, total, scopes: [{ scope, count }] }` record (or an unavailable
// note), so a script gets the same shape regardless of which store answered.
function buildJson({ root, filter, offlineSection, remoteSection }) {
  return {
    root,
    filter: filter || null,
    offline: sectionJson(offlineSection),
    remote: sectionJson(remoteSection),
  };
}

function sectionJson(section) {
  if (!section.available) {
    return { available: false, reason: section.reason, total: 0, scopes: [] };
  }
  return {
    available: true,
    total: section.total,
    scopes: section.scopes.map((s) => ({ scope: s.scope, count: s.count })),
  };
}
