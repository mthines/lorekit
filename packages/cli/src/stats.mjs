// `lorekit stats` — an at-a-glance overview of the lessons that apply to the
// current directory: how many live in each scope, split per store (offline vs
// remote), plus per-store and grand totals. Same Offline / Remote framing as
// `list`, but counts-only — no lesson bodies.
//
// Graceful by design (mirrors `list`/`search`/`show`): a `LOREKIT_DENY` ceiling
// suppresses a section, and an unconfigured remote degrades to a short note,
// never an error (exit 0). Read-only. Human-facing, so the bin wraps it in
// `traceCommand`.
//
// On cap usage: the hosted MCP surface exposes no tool that returns the user's
// total active-memory count or their configured cap (the cap is enforced by a
// DB trigger and read via `lorekit_get_limit`, neither reachable from a
// `memory.*` tool call), so `stats` deliberately reports only observed counts
// rather than guessing a `N / cap` ratio. Remote per-scope counts reflect what
// `memory.list` returns for each scope (server-side default page size), the
// same window `list` already shows.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { scopeList, gather, tallyGroups } from './lessons-view.mjs';
import { log, heading, status, c } from './util.mjs';

export async function stats(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  const scopeInfo = deriveScope(root);
  // Default to every applicable scope; `--scope <s>` narrows to one (an explicit
  // scope outside the applicable set is honoured — the user asked for it).
  const scopes = args.scope && typeof args.scope === 'string' ? [args.scope] : scopeList(scopeInfo);

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // Deny-wins section suppression, identical to `list`/`search`/`show`.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const offlineTally = localDenied ? { perScope: [], total: 0 } : tallyGroups(await gather(local, scopes));
  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteTally = remoteAvailable
    ? tallyGroups(await gather(remote, scopes))
    : { perScope: [], total: 0 };

  const offlineSection = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : { available: true, ...offlineTally };
  const remoteSection = remoteAvailable
    ? { available: true, ...remoteTally }
    : {
        available: false,
        reason: remoteDenied
          ? `disabled by deny constraint (${remoteDenied.source})`
          : remoteUnavailableReason(connection),
      };

  if (args.json) {
    log(JSON.stringify(buildJson({ root, scopes, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit stats');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);

    renderStatsSection({ title: 'Offline' }, offlineSection, scopes);
    renderStatsSection(
      { title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined },
      remoteSection,
      scopes,
    );

    log('');
  }

  // Bounded, non-PII telemetry extras (counts + a boolean) — never a scope
  // string, path, key, or token.
  return {
    exitCode: 0,
    'lorekit.cli.stats.scope_count': scopes.length,
    'lorekit.cli.stats.offline_count': offlineSection.available ? offlineSection.total : 0,
    'lorekit.cli.stats.remote_count': remoteSection.available ? remoteSection.total : 0,
    'lorekit.cli.stats.remote_available': remoteAvailable,
  };
}

// Render one store's count summary: an unavailable note, or a small right-
// aligned table of `scope   count` rows plus a `total` line. Scopes with a read
// error show the error in place of a count so a partial read is never mistaken
// for an empty scope.
function renderStatsSection(header, section, scopes) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  // Index the tally by scope so every applicable scope prints a row (a scope
  // with zero lessons still shows `0`, which is the point of an overview).
  const byScope = new Map(section.perScope.map((s) => [s.scope, s]));
  const width = Math.max(0, ...scopes.map((s) => s.length));
  for (const scope of scopes) {
    const row = byScope.get(scope) || { count: 0, error: null };
    const label = scope.padEnd(width);
    if (row.error) {
      log(`  ${c.bold(label)}  ${c.yellow('!')} ${c.dim(row.error)}`);
    } else {
      log(`  ${c.bold(label)}  ${row.count}`);
    }
  }
  log(`  ${c.dim('total'.padEnd(width))}  ${c.bold(String(section.total))}`);
}

// The `--json` payload: `{ root, scopes, offline, remote }` — each store a
// `{ available, total, scopes: [{ scope, count, error }] }` record (or an
// unavailable note), so a script gets the same shape regardless of which store
// the counts came from.
function buildJson({ root, scopes, offlineSection, remoteSection }) {
  return {
    root,
    scopes,
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
    scopes: section.perScope.map((s) => ({ scope: s.scope, count: s.count, error: s.error })),
  };
}
