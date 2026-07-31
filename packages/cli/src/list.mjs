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
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { scopeList, gather, renderSection } from './lessons-view.mjs';
import { resolveAppBase, mostSpecificScope } from './deeplink-pure.mjs';
import { emitLink } from './link.mjs';
import { log, heading, c } from './util.mjs';

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

  const offline = localDenied ? { groups: [], total: 0 } : await gather(local, scopes);
  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteResult = remoteAvailable ? await gather(remote, scopes) : { groups: [], total: 0 };

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
