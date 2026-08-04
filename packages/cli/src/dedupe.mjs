// `lorekit dedupe` — detect likely-duplicate lessons across the applicable
// scopes within each store. ZERO-DEP means a HEURISTIC, never embeddings: it
// clusters lessons whose values share a high Jaccard word-token overlap (default
// 0.8, tunable with `--threshold`). It flags candidates worth a human's eye — it
// is NOT a semantic judge and can both miss paraphrases and group coincidental
// overlaps. The pure core (`tokenize` / `similarity` / `clusterDuplicates`) lives
// in `lessons-view.mjs` and is thoroughly unit-tested.
//
// Clustering is per-store, across all applicable scopes (an offline cluster may
// span project + global; cross-STORE divergence is `diff`'s job, not this one).
// Same Offline / Remote split and graceful degradation as `list`. Read-only.
// Human-facing, so the bin wraps it in `traceCommand`.
import process from 'node:process';
import { resolveProjectRoot, readLorekitJson } from './config.mjs';
import { deriveScope } from './scope.mjs';
import { resolveDenies } from './control.mjs';
import { resolveStores, remoteUnavailableReason } from './stores.mjs';
import { scopeList, gather, gatherStream, clusterDuplicates, clusterDuplicatesBlocked, DEFAULT_MAX } from './lessons-view.mjs';
import { log, heading, status, c } from './util.mjs';

const DEFAULT_THRESHOLD = 0.8;
// Maximum entries to accumulate before the token-blocking index becomes
// memory-prohibitive. Beyond this the user must narrow via --key-prefix /
// --since / --max.
const DEDUPE_POP_CAP = 2000;

// Parse `--threshold` into a number in [0, 1]; anything unparseable or out of
// range falls back to the default (never a crash on bad input). Pure-ish helper.
export function parseThreshold(raw) {
  if (raw === undefined || raw === true) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(0, n));
}

// Read `dedupe.threshold` from .lorekit.json (non-throwing). Returns the
// repo-default threshold, or undefined when not configured.
export function repoThreshold(root) {
  const cfg = readLorekitJson(root);
  if (cfg['dedupe.threshold'] !== undefined) {
    return parseThreshold(cfg['dedupe.threshold']);
  }
  return undefined;
}

// Flatten a `gather()` result into one entry list (each entry keeps its scope)
// for cross-scope clustering, plus the scopes whose read errored (they can't be
// clustered and are surfaced, not silently dropped).
function flatten(gathered) {
  const entries = [];
  const errored = [];
  for (const g of gathered.groups || []) {
    if (g.error) {
      errored.push({ scope: g.scope, error: g.error });
      continue;
    }
    for (const e of g.entries || []) entries.push(e);
  }
  return { entries, errored };
}

export async function dedupe(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  // Threshold precedence: --threshold flag > dedupe.threshold in .lorekit.json > default (0.8).
  const threshold =
    args.threshold !== undefined
      ? parseThreshold(args.threshold)
      : (repoThreshold(root) ?? DEFAULT_THRESHOLD);
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

  // `dedupe` defaults to full-scope survey. --max, --since, --key-prefix narrow
  // the population. Population cap: 2000. Past it stop accumulating, warn, and
  // surface a narrowing hint. Use token-blocking (`clusterDuplicatesBlocked`)
  // for the one super-linear operation.
  const surveyMax = args.max !== undefined ? Number(args.max) : DEFAULT_MAX;
  const surveySince = args.since || undefined;
  const surveyUntil = args.until || undefined;
  const surveyKeyPrefix = args['key-prefix'] || undefined;

  // Stream-accumulate entries up to DEDUPE_POP_CAP and note when capped.
  async function streamAccumulate(store) {
    const accumulated = [];
    const errored = [];
    let popCapped = false;

    await gatherStream(store, scopes, {
      max: surveyMax,
      since: surveySince,
      until: surveyUntil,
      keyPrefix: surveyKeyPrefix,
      onPage: ({ scope, entries }) => {
        if (popCapped) return;
        for (const e of entries) {
          if (accumulated.length >= DEDUPE_POP_CAP) {
            popCapped = true;
            break;
          }
          accumulated.push({ ...e, scope: e.scope ?? scope });
        }
      },
    });

    return { entries: accumulated, errored, popCapped };
  }

  const buildSection = async (store, local) => {
    if (local) {
      // Local store is already exhaustive; use the existing gather path.
      const flat = flatten(await gather(store, scopes));
      return {
        available: true,
        clusters: clusterDuplicatesBlocked(flat.entries, threshold),
        errored: flat.errored,
        popCapped: false,
      };
    }
    const { entries, errored, popCapped } = await streamAccumulate(store);
    return {
      available: true,
      clusters: clusterDuplicatesBlocked(entries, threshold),
      errored,
      popCapped,
    };
  };

  const offlineSection = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : await buildSection(local, true);

  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteSection = remoteAvailable
    ? await buildSection(remote, false)
    : {
        available: false,
        reason: remoteDenied
          ? `disabled by deny constraint (${remoteDenied.source})`
          : remoteUnavailableReason(connection),
      };

  const offlineClusters = offlineSection.available ? offlineSection.clusters.length : 0;
  const remoteClusters = remoteSection.available ? remoteSection.clusters.length : 0;

  if (args.json) {
    log(JSON.stringify(buildJson({ root, scopes, threshold, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit dedupe');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);
    log(`  ${c.dim(`heuristic: Jaccard word-token overlap >= ${threshold} (not semantic)`)}`);

    if (offlineSection.available && offlineSection.popCapped) {
      log(`  ${c.yellow('!')} population cap (${DEDUPE_POP_CAP}) reached for Offline — results are partial. Narrow with --key-prefix, --since, or --max.`);
    }
    if (remoteSection.available && remoteSection.popCapped) {
      log(`  ${c.yellow('!')} population cap (${DEDUPE_POP_CAP}) reached for Remote — results are partial. Narrow with --key-prefix, --since, or --max.`);
    }

    renderDedupeSection({ title: 'Offline' }, offlineSection);
    renderDedupeSection(
      { title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined },
      remoteSection,
    );

    log('');
    const total = offlineClusters + remoteClusters;
    if (total === 0) {
      log(`  ${c.green('✓')} no likely-duplicate clusters at this threshold`);
    } else {
      const plural = total === 1 ? '' : 's';
      log(`  ${c.yellow('!')} ${total} duplicate cluster${plural} found`);
    }
    log('');
  }

  // Bounded, non-PII telemetry extras — counts + a boolean, never a scope
  // string, key, path, or token.
  return {
    exitCode: 0,
    'lorekit.cli.dedupe.scope_count': scopes.length,
    'lorekit.cli.dedupe.threshold': threshold,
    'lorekit.cli.dedupe.offline_clusters': offlineClusters,
    'lorekit.cli.dedupe.remote_clusters': remoteClusters,
    'lorekit.cli.dedupe.remote_available': remoteAvailable,
  };
}

// Render one store's clusters: each cluster lists its member scope::key lines
// and a similarity signal. A read error (a scope that couldn't be gathered) is
// surfaced up front so a partial read is never mistaken for "no duplicates".
function renderDedupeSection(header, section) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  for (const e of section.errored || []) {
    log(`  ${c.bold(e.scope)}  ${c.yellow('!')} ${c.dim(e.error)}`);
  }

  if (!section.clusters.length) {
    if (!(section.errored || []).length) log(`  ${c.dim('no likely-duplicate clusters')}`);
    return;
  }

  let n = 0;
  for (const cluster of section.clusters) {
    n += 1;
    const range =
      cluster.minSimilarity === cluster.maxSimilarity
        ? cluster.minSimilarity.toFixed(2)
        : `${cluster.minSimilarity.toFixed(2)}–${cluster.maxSimilarity.toFixed(2)}`;
    log(`  ${c.yellow('•')} cluster ${n} ${c.dim(`(${cluster.size} memories, similarity ${range})`)}`);
    for (const m of cluster.members) {
      log(`    ${c.cyan('-')} ${m.scope}::${m.key}`);
    }
  }
}

// The `--json` payload: `{ root, scopes, threshold, offline, remote }` — each
// store a `{ available, clusters: [{ members, size, minSimilarity,
// maxSimilarity }], errored }` record (or an unavailable note).
function buildJson({ root, scopes, threshold, offlineSection, remoteSection }) {
  return {
    root,
    scopes,
    threshold,
    offline: sectionJson(offlineSection),
    remote: sectionJson(remoteSection),
  };
}

function sectionJson(section) {
  if (!section.available) {
    return { available: false, reason: section.reason, clusters: [], errored: [] };
  }
  return {
    available: true,
    clusters: section.clusters,
    errored: section.errored || [],
  };
}
