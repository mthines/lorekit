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
import { scopeList, gather, gatherStream, clusterDuplicates, clusterDuplicatesBlocked, clusterByKeyPattern, compileKeyPattern, DEFAULT_MAX } from './lessons-view.mjs';
import { log, heading, status, err, c } from './util.mjs';

const DEFAULT_THRESHOLD = 0.8;
// Maximum entries to accumulate before the survey becomes memory-prohibitive.
// It bounds the accumulated entry list itself, so it applies in BOTH modes —
// key-shape clustering is O(n) and needs no blocking index, but it still holds
// the whole population in memory, and an unbounded remote drain is the risk the
// cap exists for. In value mode it additionally bounds the token-blocking index,
// which is the super-linear part. Beyond the cap the results are genuinely
// partial in either mode, and the user must narrow via --key-prefix / --since /
// --max.
const DEDUPE_POP_CAP = 2000;

// Smallest threshold the blocked clusterer accepts. `clusterDuplicatesBlocked`
// is provably equivalent to the oracle `clusterDuplicates` only for
// threshold > 0 (at 0 the oracle clusters even zero-overlap pairs, which the
// token-blocking sweep never generates). Any positive value below the smallest
// possible Jaccard behaves identically to 0+ while preserving that invariant,
// so we floor to a tiny epsilon rather than accept a literal 0.
const MIN_THRESHOLD = Number.EPSILON;

// Parse `--threshold` into a number in (0, 1]; anything unparseable or out of
// range falls back to the default (never a crash on bad input). Pure-ish helper.
export function parseThreshold(raw) {
  if (raw === undefined || raw === true) return DEFAULT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.min(1, Math.max(MIN_THRESHOLD, n));
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

  // `--cluster-by-key <regex>` switches from value-overlap clustering to KEY-shape
  // clustering: entries whose keys share the same first capture group (or full
  // match) of the regex are grouped as a duplicate family — catches coordinate-key
  // debt (e.g. `bucket::pr{N}-{commentId}::slug`) that the Jaccard heuristic misses
  // when the values differ. A bare flag (no value) or an unparseable regex is a
  // usage error: report it and exit non-zero rather than silently surveying by value.
  const clusterByKeyRaw = args['cluster-by-key'];
  const byKeyMode = clusterByKeyRaw !== undefined;
  const keyPattern = byKeyMode ? compileKeyPattern(clusterByKeyRaw) : null;
  if (byKeyMode && !keyPattern) {
    err(
      clusterByKeyRaw === true
        ? '--cluster-by-key needs a regex value, e.g. --cluster-by-key "(pr\\d+-\\d+)"'
        : `--cluster-by-key: invalid regex ${JSON.stringify(String(clusterByKeyRaw))}`,
    );
    return { exitCode: 1 };
  }
  // Key-shape mode has no similarity cutoff, so an explicit `--threshold` would
  // be silently ignored — the same silent fallback the bad-regex branch above
  // refuses. Refuse it too. Only the EXPLICIT flag errors: a repo-level
  // `dedupe.threshold` in .lorekit.json is a value-mode default, not a request,
  // so it must not break a key-mode run.
  if (byKeyMode && args.threshold !== undefined) {
    err('--threshold is not used with --cluster-by-key (key-shape clustering has no similarity cutoff); drop one of them');
    return { exitCode: 1 };
  }

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
      // Local store is already exhaustive; gather everything, then apply the
      // SAME narrowing the remote path gets server-side (the local store's
      // `list()` honours only scope/tags, so it can't narrow itself). Filtering
      // here — before the population cap — is what makes `--key-prefix`/
      // `--since`/`--until`/`--max` real offline instead of silent no-ops.
      const flat = flatten(await gather(store, scopes));
      let entries = flat.entries;
      if (surveyKeyPrefix) {
        entries = entries.filter(
          (e) => typeof e.key === 'string' && e.key.startsWith(surveyKeyPrefix),
        );
      }
      // `created_at` is compared as an ISO string; both bounds mirror the REST
      // handler — inclusive `since`, exclusive `until` (the `[since, until)`
      // window). An entry with no `created` timestamp is kept (never dropped by
      // a bound it can't be judged against).
      if (surveySince) entries = entries.filter((e) => !e.created || e.created >= surveySince);
      if (surveyUntil) entries = entries.filter((e) => !e.created || e.created < surveyUntil);
      // Silent `--max` cap first, then the memory-safety population cap that
      // drives the "partial results" warning — mirroring the remote path where
      // gatherStream's `max` and the DEDUPE_POP_CAP are distinct.
      if (entries.length > surveyMax) entries = entries.slice(0, surveyMax);
      let popCapped = false;
      if (entries.length > DEDUPE_POP_CAP) {
        entries = entries.slice(0, DEDUPE_POP_CAP);
        popCapped = true;
      }
      return {
        available: true,
        clusters: byKeyMode
          ? clusterByKeyPattern(entries, keyPattern)
          : clusterDuplicatesBlocked(entries, threshold),
        errored: flat.errored,
        popCapped,
      };
    }
    const { entries, errored, popCapped } = await streamAccumulate(store);
    return {
      available: true,
      clusters: byKeyMode
        ? clusterByKeyPattern(entries, keyPattern)
        : clusterDuplicatesBlocked(entries, threshold),
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
    log(JSON.stringify(buildJson({ root, scopes, threshold, byKeyMode, keyPattern, offlineSection, remoteSection }), null, 2));
  } else {
    heading('LoreKit dedupe');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);
    log(
      byKeyMode
        ? `  ${c.dim(`key-shape: clustering by shared key capture of /${keyPattern.source}/`)}`
        : `  ${c.dim(`heuristic: Jaccard word-token overlap >= ${threshold} (not semantic)`)}`,
    );

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
      // "at this threshold" is only true in value mode — key-shape mode has no
      // cutoff, so name the pattern that found nothing instead.
      log(
        byKeyMode
          ? `  ${c.green('✓')} no key-shape clusters for /${keyPattern.source}/`
          : `  ${c.green('✓')} no likely-duplicate clusters at this threshold`,
      );
    } else {
      const plural = total === 1 ? '' : 's';
      log(`  ${c.yellow('!')} ${total} duplicate cluster${plural} found`);
    }
    log('');
  }

  // Bounded, non-PII telemetry extras — counts + a boolean, never a scope
  // string, key, path, or token. `threshold` is emitted only in value mode,
  // where it is the cutoff actually applied; the key-mode pattern is user text
  // and is never emitted, only the bounded mode name.
  return {
    exitCode: 0,
    'lorekit.cli.dedupe.scope_count': scopes.length,
    'lorekit.cli.dedupe.mode': byKeyMode ? 'key' : 'value',
    ...(byKeyMode ? {} : { 'lorekit.cli.dedupe.threshold': threshold }),
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
    // Key-shape clusters carry a `keyGroup`; value-overlap clusters carry a
    // similarity range. Render whichever signal the cluster has.
    let signal;
    if (cluster.keyGroup !== undefined) {
      signal = `${cluster.size} memories, key-group "${cluster.keyGroup}"`;
    } else {
      const range =
        cluster.minSimilarity === cluster.maxSimilarity
          ? cluster.minSimilarity.toFixed(2)
          : `${cluster.minSimilarity.toFixed(2)}–${cluster.maxSimilarity.toFixed(2)}`;
      signal = `${cluster.size} memories, similarity ${range}`;
    }
    log(`  ${c.yellow('•')} cluster ${n} ${c.dim(`(${signal})`)}`);
    for (const m of cluster.members) {
      log(`    ${c.cyan('-')} ${m.scope}::${m.key}`);
    }
  }
}

// The `--json` payload: `{ root, scopes, mode, threshold|keyPattern, offline,
// remote }`. In value mode (`mode: "value"`) each cluster carries `minSimilarity`
// / `maxSimilarity`; in key-shape mode (`mode: "key"`) each carries `keyGroup`.
// Each store is a `{ available, clusters, errored }` record (or an unavailable note).
function buildJson({ root, scopes, threshold, byKeyMode, keyPattern, offlineSection, remoteSection }) {
  return {
    root,
    scopes,
    mode: byKeyMode ? 'key' : 'value',
    ...(byKeyMode ? { keyPattern: keyPattern.source } : { threshold }),
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
