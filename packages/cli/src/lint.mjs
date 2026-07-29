// `lorekit lint` — flag low-quality lessons across the applicable scopes and
// both stores. Each finding names the rule it violated (empty/whitespace value,
// suspiciously short value, untrimmed value, empty key, malformed scope). The
// rules are pure predicates in `lessons-view.mjs` (`LINT_RULES` / `lintEntry`),
// each independently unit-tested.
//
// Exit convention: `lint` exits NON-ZERO (1) when any finding exists, so it is
// usable as a CI gate (`lorekit lint || fail`); a clean run — or a run where the
// only issue is an unavailable store — exits 0. `--json` carries the structured
// findings either way. Same Offline / Remote split and graceful degradation as
// `list`; a `LOREKIT_DENY` ceiling or an unconfigured remote is a note, not an
// error. Read-only. Human-facing, so the bin wraps it in `traceCommand`.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { scopeList, gather, lintGroups } from './lessons-view.mjs';
import { log, heading, status, c } from './util.mjs';

export async function lint(args) {
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

  const offlineResult = localDenied ? { groups: [], total: 0 } : lintGroups(await gather(local, scopes));
  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteResult = remoteAvailable ? lintGroups(await gather(remote, scopes)) : { groups: [], total: 0 };

  const offlineSection = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : { available: true, ...offlineResult };
  const remoteSection = remoteAvailable
    ? { available: true, ...remoteResult }
    : {
        available: false,
        reason: remoteDenied
          ? `disabled by deny constraint (${remoteDenied.source})`
          : remoteUnavailableReason(connection),
      };

  const totalFindings =
    (offlineSection.available ? offlineSection.total : 0) +
    (remoteSection.available ? remoteSection.total : 0);

  if (args.json) {
    log(JSON.stringify(buildJson({ root, scopes, offlineSection, remoteSection, totalFindings }), null, 2));
  } else {
    heading('LoreKit lint');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);

    renderLintSection({ title: 'Offline' }, offlineSection);
    renderLintSection(
      { title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined },
      remoteSection,
    );

    log('');
    if (totalFindings === 0) {
      log(`  ${c.green('✓')} no lint issues in the applicable scopes`);
    } else {
      const plural = totalFindings === 1 ? '' : 's';
      log(`  ${c.yellow('!')} ${totalFindings} lint issue${plural} found`);
    }
    log('');
  }

  // Exit non-zero when findings exist so `lint` is usable as a CI gate. An
  // unavailable store is never itself a failure — only actual findings are.
  // Bounded, non-PII telemetry extras — counts + a boolean.
  return {
    exitCode: totalFindings > 0 ? 1 : 0,
    'lorekit.cli.lint.scope_count': scopes.length,
    'lorekit.cli.lint.offline_findings': offlineSection.available ? offlineSection.total : 0,
    'lorekit.cli.lint.remote_findings': remoteSection.available ? remoteSection.total : 0,
    'lorekit.cli.lint.total_findings': totalFindings,
    'lorekit.cli.lint.remote_available': remoteAvailable,
  };
}

// Render one store's findings, grouped by scope: `key  rule — message` per
// finding. A scope with no findings and no error is omitted; a read error is
// surfaced in place (its entries couldn't be linted).
function renderLintSection(header, section) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  const printable = (section.groups || []).filter((g) => g.findings.length || g.error);
  if (!printable.length) {
    log(`  ${c.dim('no lint issues in the applicable scopes')}`);
    return;
  }

  for (const g of printable) {
    log(`  ${c.bold(g.scope)}`);
    if (g.error) {
      log(`    ${c.yellow('!')} ${c.dim(g.error)}`);
      continue;
    }
    for (const f of g.findings) {
      log(`    ${c.yellow('•')} ${g.scope}::${f.key}  ${c.dim(`[${f.rule}]`)} ${f.message}`);
    }
  }
}

// The `--json` payload: `{ root, scopes, total, offline, remote }` — each store
// a `{ available, total, scopes: [{ scope, error, findings: [{ key, rule,
// message }] }] }` record (or an unavailable note), so a script gets the same
// structured finding list regardless of which store it came from.
function buildJson({ root, scopes, offlineSection, remoteSection, totalFindings }) {
  return {
    root,
    scopes,
    total: totalFindings,
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
    scopes: (section.groups || []).map((g) => ({
      scope: g.scope,
      error: g.error || null,
      findings: g.findings,
    })),
  };
}
