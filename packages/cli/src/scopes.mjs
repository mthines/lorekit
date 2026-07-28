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
// Remote enumeration is NOT possible: the hosted MCP surface exposes no "list
// all scopes" tool — every read tool (memory.list / search / read) REQUIRES a
// scope — so the Remote section is always an honest note (never faked), the same
// way `stats` omits a cap-usage figure. It still degrades gracefully at exit 0.
//
// Graceful, read-only, human-facing (the bin wraps it in `traceCommand`).
// `LOREKIT_DENY` suppresses a section; `--scope <s>` filters the inventory to
// scopes whose string contains that substring; `--json` emits `{ offline,
// remote }`.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { summarizeScopeInventory, filterScopeInventory } from './lessons-view.mjs';
import { log, heading, status, c } from './util.mjs';

// The honest note the Remote section shows when it isn't denied/unconfigured:
// the hosted MCP surface simply can't enumerate scopes. Exported so tests can
// assert the exact wording rather than a fragile substring.
export const REMOTE_SCOPES_UNSUPPORTED =
  'remote scope enumeration is not supported by the hosted MCP surface (memory.list requires a scope)';

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

  // Remote: never enumerable. A deny note, an unconfigured note, or the honest
  // "not supported" note — all graceful (exit 0). Order matches the other
  // commands' precedence: deny first, then connectivity, then the capability.
  let remoteSection;
  if (remoteDenied) {
    remoteSection = { available: false, reason: `disabled by deny constraint (${remoteDenied.source})` };
  } else if (!remote.usable()) {
    remoteSection = { available: false, reason: remoteUnavailableReason(connection) };
  } else {
    remoteSection = { available: false, reason: REMOTE_SCOPES_UNSUPPORTED };
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

  // Bounded, non-PII telemetry extras (counts + a boolean) — never a scope
  // string, path, or token. `remote_available` is always false: the surface
  // can't enumerate, and saying so is the honest signal.
  return {
    exitCode: 0,
    'lorekit.cli.scopes.offline_scope_count': offlineSection.available ? offlineSection.scopes.length : 0,
    'lorekit.cli.scopes.offline_total': offlineSection.available ? offlineSection.total : 0,
    'lorekit.cli.scopes.filtered': Boolean(filter),
    'lorekit.cli.scopes.remote_available': false,
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
