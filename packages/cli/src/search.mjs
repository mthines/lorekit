// `lorekit search <query>` — full-text search the lessons that apply to the
// current directory, across BOTH stores and every applicable scope, rendered in
// the same Offline / Remote split as `list`. A lesson matches when the query
// appears (case-insensitively, as a LITERAL substring) in its key or value.
//
// Why filter `gather()` rather than call each store's `search()`: the two stores
// disagree on search semantics — the local store does a literal substring match,
// the remote store delegates to server-side FTS (ranking, stemming). To give one
// deterministic, spec-defined behaviour across both — and to guarantee a query
// full of regex metacharacters is matched verbatim — the match runs here, over
// the exact same `gather()` seam `list` uses, via the pure `matchesQuery` filter.
//
// Graceful by design (mirrors `list`): an unconfigured remote is a short note,
// never an error; a per-scope read failure is a warning, not a crash. Read-only,
// archived hidden. Human-facing, so the bin wraps it in `traceCommand`.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { scopeList, gather, filterGroups, renderSection } from './lessons-view.mjs';
import { log, err, heading, c } from './util.mjs';

export async function search(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // The query is the first positional after the command name. An empty/missing
  // query is a usage error (non-zero exit) — searching for nothing is meaningless
  // and would otherwise degrade to `list`.
  const query = typeof args._[1] === 'string' ? args._[1] : '';
  if (!query.trim()) {
    err(`${c.red('Usage:')} lorekit search <query> [--scope <s>] [--json]`);
    err(`Provide a search term. Run ${c.cyan('lorekit search --help')} for options.`);
    return 1;
  }

  const scopeInfo = deriveScope(root);
  // Default to every applicable scope; `--scope <s>` narrows to one (an explicit
  // scope outside the applicable set is honoured — the user asked for it).
  const scopes = args.scope && typeof args.scope === 'string' ? [args.scope] : scopeList(scopeInfo);

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // Deny-wins section suppression, identical to `list`.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const offline = localDenied
    ? { groups: [], total: 0 }
    : filterGroups(await gather(local, scopes), query);
  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteResult = remoteAvailable
    ? filterGroups(await gather(remote, scopes), query)
    : { groups: [], total: 0 };

  const offlineSection = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : { available: true, ...offline };
  const remoteSection = remoteAvailable
    ? { available: true, ...remoteResult }
    : {
        available: false,
        reason: remoteDenied
          ? `disabled by deny constraint (${remoteDenied.source})`
          : remoteUnavailableReason(connection),
      };

  if (args.json) {
    log(JSON.stringify(buildJson({ root, query, scopes, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit search');
    log(`  query:   ${c.dim(query)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);

    const empty = 'no lessons match';
    renderSection({ title: 'Offline', empty }, offlineSection);
    renderSection(
      { title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined, empty },
      remoteSection,
    );

    log('');
  }

  // Bounded, non-PII telemetry extras — counts + a boolean, never the query, a
  // scope string, key, path, or token.
  return {
    exitCode: 0,
    'lorekit.cli.search.scope_count': scopes.length,
    'lorekit.cli.search.offline_matches': offline.total,
    'lorekit.cli.search.remote_matches': remoteResult.total,
    'lorekit.cli.search.remote_available': remoteAvailable,
  };
}

// The `--json` payload: `{ query, root, scopes, offline, remote }` — normalized
// per-scope groups per section so a script gets the same shape regardless of
// which store a match came from (the exact shape `list --json` emits, plus the
// query echoed back).
function buildJson({ root, query, scopes, offlineSection, remoteSection }) {
  return {
    query,
    root,
    scopes,
    offline: sectionJson(offlineSection),
    remote: sectionJson(remoteSection),
  };
}

function sectionJson(section) {
  if (!section.available) {
    return { available: false, reason: section.reason, total: 0, groups: [] };
  }
  return {
    available: true,
    total: section.total,
    groups: (section.groups || []).map((g) => ({
      scope: g.scope,
      error: g.error || null,
      // `gather()` already normalized these entries; the filter preserved them.
      entries: g.entries,
    })),
  };
}
