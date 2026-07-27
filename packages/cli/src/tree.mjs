// `lorekit tree` (alias `resolve`) — show the applicable scopes as a precedence
// hierarchy and mark, for any key that lives at MORE THAN ONE scope, which
// scope's lesson actually WINS and which are shadowed. This answers "which
// lesson applies here, and what is being overridden?".
//
// Precedence is not an assumption — it mirrors the hook engine exactly. The
// SessionStart hook (`core/lessons.mjs → fetchLessons`) reads the scopes in
// `deriveScope().readOrder` (branch → repo → global, most-specific first) and
// keeps the FIRST value seen per key, so a more-specific scope shadows a broader
// scope's same-key lesson. `tree` resolves over that same `readOrder` set via
// the pure `resolvePrecedence`, so it shows the same resolution order the agent
// is injected with (the hook additionally caps the injected set at MAX_LESSONS;
// `tree` is uncapped, so a large workspace may list more winners than the hook
// injects).
//
// NOTE on scope coverage: `readOrder` is the injected set, and it deliberately
// excludes `project::` — the hooks never inject project-scope lessons, so `tree`
// doesn't either (browse those with `lorekit list`). Both stores are resolved
// independently (precedence is per-store — the hook reads one resolved store),
// in the same Offline / Remote split as `list`. Graceful, read-only, wrapped in
// `traceCommand` by the bin.
import process from 'node:process';
import { resolveProjectRoot } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { gather, resolvePrecedence, preview, shortDate } from './lessons-view.mjs';
import { log, heading, status, c } from './util.mjs';

export async function tree(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  const scopeInfo = deriveScope(root);
  // Default to the injected resolution set (`readOrder`, most-specific first);
  // `--scope <s>` narrows to one (honored even outside the set — the user asked).
  const scopes = args.scope && typeof args.scope === 'string' ? [args.scope] : scopeInfo.readOrder;

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });

  // Deny-wins section suppression, identical to the other read commands.
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const offlineResolved = localDenied ? null : resolvePrecedence(await gather(local, scopes));
  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteResolved = remoteAvailable ? resolvePrecedence(await gather(remote, scopes)) : null;

  const offlineSection = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : { available: true, ...offlineResolved };
  const remoteSection = remoteAvailable
    ? { available: true, ...remoteResolved }
    : {
        available: false,
        reason: remoteDenied
          ? `disabled by deny constraint (${remoteDenied.source})`
          : remoteUnavailableReason(connection),
      };

  if (args.json) {
    log(JSON.stringify(buildJson({ root, scopes, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit resolution tree');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);
    log(`  ${c.dim('precedence order (most-specific first); a more-specific scope wins a duplicate key')}`);

    renderTreeSection({ title: 'Offline' }, offlineSection);
    renderTreeSection(
      { title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined },
      remoteSection,
    );

    log('');
  }

  // Bounded, non-PII telemetry extras — counts + a boolean, never a scope
  // string, key, path, or token.
  return {
    exitCode: 0,
    'lorekit.cli.tree.scope_count': scopes.length,
    'lorekit.cli.tree.offline_winning': offlineSection.available ? offlineSection.winningTotal : 0,
    'lorekit.cli.tree.offline_shadowed': offlineSection.available ? offlineSection.shadowedTotal : 0,
    'lorekit.cli.tree.remote_shadowed': remoteSection.available ? remoteSection.shadowedTotal : 0,
    'lorekit.cli.tree.remote_available': remoteAvailable,
  };
}

// Render one store's resolution: each scope in precedence order with its entries
// tagged winning (✓) or shadowed (↳ shadowed by <scope>). A scope with no
// entries and no error is omitted; a read error is surfaced in place.
function renderTreeSection(header, section) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  const printable = (section.groups || []).filter((g) => g.entries.length || g.error);
  if (!printable.length) {
    log(`  ${c.dim('no lessons found in the applicable scopes')}`);
    return;
  }

  for (const g of printable) {
    log(`  ${c.bold(g.scope)}`);
    if (g.error) {
      log(`    ${c.yellow('!')} ${c.dim(g.error)}`);
      continue;
    }
    for (const e of g.entries) {
      const when = e.updated ? `  ${c.dim(`(updated ${shortDate(e.updated)})`)}` : '';
      const mark = e.winning ? c.green('✓') : c.yellow('↳');
      const tag = e.winning ? '' : `  ${c.dim(`shadowed by ${e.shadowedBy}`)}`;
      log(`    ${mark} ${e.key}${tag}${when}`);
      if (e.value) log(`      ${c.dim(preview(e.value))}`);
    }
  }

  log(
    `  ${c.dim(`${section.winningTotal} winning, ${section.shadowedTotal} shadowed`)}`,
  );
}

// The `--json` payload: per-section resolved groups (each entry carrying its
// `winning` / `shadowedBy` tags), the flat `winners` list, and the counts — so a
// script gets the resolution verdict directly, in the same shape per store.
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
    return { available: false, reason: section.reason, winners: [], groups: [] };
  }
  return {
    available: true,
    winningTotal: section.winningTotal,
    shadowedTotal: section.shadowedTotal,
    winners: section.winners,
    groups: section.groups,
  };
}
