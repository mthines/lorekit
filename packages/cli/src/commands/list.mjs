// `lorekit list` — show the lessons that apply to the current directory, split
// into an Offline section (the local two-tier store) and a Remote section (the
// hosted MCP store). Scopes searched are the ones `deriveScope` resolves for the
// cwd: project, branch, repo, and global.
//
// Graceful by design: when no remote token/endpoint is configured the Remote
// section is a short note on how to set it up — never an error (mirrors
// `doctor`'s tone). Human-facing, so it is wrapped in `traceCommand` by the bin.
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { deriveScope } from '../shared/scope.mjs';
import { resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { scopeList, gather, gatherStream, renderSection, DEFAULT_MAX } from '../shared/lessons-view.mjs';
import { resolveAppBase, mostSpecificScope } from '../shared/deeplink-pure.mjs';
import { emitLink } from './link.mjs';
import { log, heading, c } from '../shared/util.mjs';

// Abbreviate the user's home directory to `~` for readable paths.
function prettyPath(p) {
  const home = os.homedir();
  return p && home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// A human label for where the offline store reads from.
function offlineSubtitle(local, root) {
  const home = prettyPath(local.homeDir);
  if (!local.projectActive()) return `${home} (home tier only — no project .lorekit/ yet)`;
  const projRel = path.relative(root, local.projectDir) || local.projectDir;
  return `${projRel} + ${home}`;
}

export async function list(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  const scopeInfo = deriveScope(root);
  // Default to every applicable scope; `--scope <s>` narrows to one (an explicit
  // scope outside the applicable set is honoured — the user asked for it).
  const scopes = args.scope && typeof args.scope === 'string' ? [args.scope] : scopeList(scopeInfo);
  // Optional taxonomy filters — `--kind lesson --host reviewer` narrows to one
  // family/owner. Comma lists are honoured by the remote store's query builder.
  const filters = {};
  if (typeof args.kind === 'string') filters.kind = args.kind;
  if (typeof args.host === 'string') filters.host = args.host;

  // `--link` short-circuits: print the Explorer deep link for the current
  // context (the most-specific applicable scope, or `--scope`), no store reads.
  if (args.link) {
    const base = resolveAppBase({ base: args.base, env });
    const scope =
      args.scope && typeof args.scope === 'string' ? args.scope : mostSpecificScope(scopeInfo);
    const params = {};
    if (scope) params.scope = scope;
    return emitLink({ params, base, json: args.json });
  }

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // A `LOREKIT_DENY=remote|local` privacy/compliance ceiling (deny-wins, never
  // overridable) suppresses that section entirely — the same invariant the
  // agent-facing control model enforces, honored here in the human read view.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  // --all: drain all pages from the remote store (for large scopes). Default
  // is single-page per scope (what `list` has always shown). The local store is
  // always exhaustive regardless of --all.
  const surveyAll = Boolean(args.all);
  const surveyMax = args.max !== undefined ? Number(args.max) : DEFAULT_MAX;
  const surveySince = args.since || undefined;
  const surveyUntil = args.until || undefined;

  // Taxonomy `keep` predicate mirroring `gather()`'s: `gatherStream` neither
  // forwards `kind`/`host` to the store nor post-filters, so a `--all` drain
  // must apply the same narrowing here or `list --all --kind X` would ignore X.
  const wanted = (v) =>
    v == null ? null : new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean));
  const kindSet = wanted(filters.kind);
  const hostSet = wanted(filters.host);
  const keep = (e) =>
    (!kindSet || (e.kind != null && kindSet.has(e.kind))) &&
    (!hostSet || (e.host != null && hostSet.has(e.host)));

  const offline = localDenied ? { groups: [], total: 0 } : await gather(local, scopes, filters);
  const remoteAvailable = !remoteDenied && remote.usable();
  let remoteResult;
  if (!remoteAvailable) {
    remoteResult = { groups: [], total: 0 };
  } else if (surveyAll) {
    // Full drain: accumulate all pages into a groups-shaped result.
    const accumulated = new Map();
    for (const scope of scopes) accumulated.set(scope, []);
    await gatherStream(remote, scopes, {
      max: surveyMax,
      since: surveySince,
      until: surveyUntil,
      onPage: ({ scope, entries }) => {
        const arr = accumulated.get(scope);
        if (arr) for (const e of entries) if (keep(e)) arr.push(e);
      },
    });
    const groups = [];
    let total = 0;
    for (const scope of scopes) {
      const entries = accumulated.get(scope) || [];
      total += entries.length;
      groups.push({ scope, entries, error: null });
    }
    remoteResult = { groups, total };
  } else {
    remoteResult = await gather(remote, scopes, filters);
  }

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
    log(JSON.stringify(buildJson({ root, scopes, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit memories');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);

    renderSection(
      { title: 'Offline', subtitle: localDenied ? undefined : offlineSubtitle(local, root) },
      offlineSection,
    );
    renderSection(
      { title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined },
      remoteSection,
    );

    log('');
  }

  // Bounded, non-PII telemetry extras (counts + a boolean) — never a scope
  // string, path, key, or token.
  return {
    exitCode: 0,
    'lorekit.cli.list.scope_count': scopes.length,
    'lorekit.cli.list.offline_count': offline.total,
    'lorekit.cli.list.remote_count': remoteResult.total,
    'lorekit.cli.list.remote_available': remoteAvailable,
  };
}

// The `--json` payload: normalized groups per section so a script gets the same
// shape regardless of which store an entry came from.
function buildJson({ root, scopes, offlineSection, remoteSection }) {
  return { root, scopes, offline: sectionJson(offlineSection), remote: sectionJson(remoteSection) };
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
      // `gather()` already normalized these entries; no second pass needed.
      entries: g.entries,
    })),
  };
}
