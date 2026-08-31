// `lorekit invariants <candidates>` — the compile pipeline's candidate scan.
//
//   cluster  →  groom-merge  →  compile candidate  →  invariant
//
// `candidates` is a read-only survey over the memory store that reuses
// `dedupe`'s Jaccard clustering to find near-duplicate lessons, then ranks
// the clusters worth compiling into a hand-written `obligations-map.mjs`
// entry. It never auto-compiles and never gates anything — it prints
// candidates for a human to review, per the compile pipeline's "never
// auto-compile, never auto-gate" rule (see `../shared/recurrence-clusters.mjs`
// and `../shared/obligations-map.mjs`'s `state` ladder). For each candidate it
// prints EVERY memory the merge would collapse — that list is the whole
// point of the command, so it is the default view, not behind `--verbose`.
//
// Criteria (pure scoring in `../shared/candidates-pure.mjs`):
//   - summed seen_count across a cluster's members >= --min-seen-count
//     (default 3), OR any member's `<!-- meta: ... status=... -->` comment
//     already declares a non-"active" status
//   - ranked by (summed seen_count × distinct scopes), descending
//
// What this deliberately does NOT do:
//   - classify a trigger-context into a glob/command/error-shape. The raw
//     `trigger-context` string (when a lesson's meta comment carries one) is
//     printed verbatim, never interpreted — "parses into a detectable
//     trigger" is the human step the compile pipeline protects.
//   - check `compiled_to`. No such field exists yet (no schema, no server
//     support — see the kickoff's Open Questions), so a candidate already
//     compiled into an obligations-map.mjs entry can still surface here. A
//     known, named gap until `compiled_to` lands, not a silent omission.
//
// Value-mode clustering only (the same `clusterDuplicatesBlocked` heuristic
// `dedupe` defaults to) — key-shape clustering (`dedupe --cluster-by-key`) is
// a naming-debt signal, not a recurrence-candidate one, and stays dedupe's.
//
// Reads raw store rows directly (skipping `gather()`/`gatherStream()`'s
// `normalizeEntry`, which drops `seen_count`) because this scan's whole
// premise is the seen_count signal that `dedupe` never needed. Offline +
// Remote split and the same memory-safety population cap as `dedupe`.
//
// Registered `native` (CLI-only, no MCP tool, no REST route, no
// `tool-catalog.ts` entry) — matching how `obligations` is registered.
import process from 'node:process';
import { resolveProjectRoot } from '../shared/config.mjs';
import { deriveScope } from '../shared/scope.mjs';
import { resolveDenies } from '../shared/control.mjs';
import { resolveStores, remoteUnavailableReason } from '../shared/stores.mjs';
import { scopeList, clusterDuplicatesBlocked, DEFAULT_MAX } from '../shared/lessons-view.mjs';
import { rankCandidates } from '../shared/candidates-pure.mjs';
import { resolveRecurrenceClass } from '../shared/recurrence-clusters.mjs';
import { seenCountOf } from '../store/entry-fields.mjs';
import { log, heading, status, err, c } from '../shared/util.mjs';

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_MIN_SEEN_COUNT = 3;
// Mirrors dedupe's memory-safety population cap — the same super-linear
// clustering step runs here.
const POP_CAP = 2000;
const STREAM_PAGE_LIMIT = 100;

function errorMessage(res) {
  return res?.networkError ?? res?.error?.message ?? res?.error ?? 'error';
}

// Local store is exhaustive and has no server-side narrowing (mirrors
// dedupe's local branch) — gather everything, then filter/cap in JS. Raw rows
// (not run through normalizeEntry) so seen_count survives.
async function localRawEntries(store, scopes, { keyPrefix, since, until, max }) {
  const entries = [];
  const errored = [];
  for (const scope of scopes) {
    let res;
    try {
      res = await store.list({ scope });
    } catch (e) {
      res = { ok: false, networkError: (e && e.message) || 'error' };
    }
    if (!res || res.ok === false) {
      errored.push({ scope, error: errorMessage(res) });
      continue;
    }
    for (const e of res.entries || []) entries.push({ ...e, scope: e.scope ?? scope });
  }
  let filtered = entries;
  if (keyPrefix) filtered = filtered.filter((e) => typeof e.key === 'string' && e.key.startsWith(keyPrefix));
  if (since) filtered = filtered.filter((e) => !e.created || e.created >= since);
  if (until) filtered = filtered.filter((e) => !e.created || e.created < until);
  if (filtered.length > max) filtered = filtered.slice(0, max);
  let popCapped = false;
  if (filtered.length > POP_CAP) {
    filtered = filtered.slice(0, POP_CAP);
    popCapped = true;
  }
  return { entries: filtered, errored, popCapped };
}

// Remote: paginate via cursor with the same param names gatherStream forwards
// server-side, but skip normalizeEntry so seen_count survives.
async function remoteRawEntries(store, scopes, { keyPrefix, since, until, max }) {
  const entries = [];
  const errored = [];
  let popCapped = false;
  let surveyed = 0;
  for (const scope of scopes) {
    if (popCapped || surveyed >= max) break;
    let cursor;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = max - surveyed;
      if (remaining <= 0) break;
      const pageLimit = Math.min(STREAM_PAGE_LIMIT, remaining);
      let res;
      try {
        res = await store.list({
          scope,
          limit: pageLimit,
          cursor,
          ...(since ? { created_since: since } : {}),
          ...(until ? { created_until: until } : {}),
          ...(keyPrefix ? { key_prefix: keyPrefix } : {}),
        });
      } catch (e) {
        res = { ok: false, networkError: (e && e.message) || 'error' };
      }
      if (!res || res.ok === false) {
        errored.push({ scope, error: errorMessage(res) });
        break;
      }
      for (const e of res.entries || []) {
        if (entries.length >= POP_CAP) {
          popCapped = true;
          break;
        }
        entries.push({ ...e, scope: e.scope ?? scope });
      }
      surveyed += (res.entries || []).length;
      if (popCapped || !res.hasMore || !res.nextCursor) break;
      cursor = res.nextCursor;
      if (surveyed >= max) break;
    }
  }
  return { entries, errored, popCapped };
}

// Cluster raw entries (clusterDuplicatesBlocked only reads .scope/.key/.value,
// so raw rows work unmodified), then re-attach seenCount/value per member —
// the clusterer's own output narrows members down to {scope,key}.
function buildCandidates(entries, { threshold, minSeenCount }) {
  const byAddress = new Map(entries.map((e) => [`${e.scope}::${e.key}`, e]));
  const clusters = clusterDuplicatesBlocked(entries, threshold).map((cl) => ({
    ...cl,
    members: cl.members.map((m) => {
      const raw = byAddress.get(`${m.scope}::${m.key}`);
      return { scope: m.scope, key: m.key, seenCount: seenCountOf(raw), value: raw?.value ?? '' };
    }),
  }));
  return rankCandidates(clusters, { minSeenCount, resolveClass: resolveRecurrenceClass });
}

async function candidates(args) {
  const root = resolveProjectRoot(args.dir);
  const env = { ...process.env };
  if (args.store) env.LOREKIT_STORE = args.store;

  const threshold = DEFAULT_THRESHOLD;
  const minSeenCount = args['min-seen-count'] !== undefined ? Number(args['min-seen-count']) : DEFAULT_MIN_SEEN_COUNT;

  const scopeInfo = deriveScope(root);
  const scopes = args.scope && typeof args.scope === 'string' ? [args.scope] : scopeList(scopeInfo);

  const { local, remote, connection } = resolveStores(root, {
    env,
    endpoint: args.endpoint,
    token: args.token,
  });
  const { localDenied, remoteDenied } = resolveDenies(root, { env });

  const surveyMax = args.max !== undefined ? Number(args.max) : DEFAULT_MAX;
  const surveySince = args.since || undefined;
  const surveyUntil = args.until || undefined;
  const surveyKeyPrefix = args['key-prefix'] || undefined;
  const narrow = { keyPrefix: surveyKeyPrefix, since: surveySince, until: surveyUntil, max: surveyMax };

  const offlineSection = localDenied
    ? { available: false, reason: `disabled by deny constraint (${localDenied.source})` }
    : await (async () => {
        const { entries, errored, popCapped } = await localRawEntries(local, scopes, narrow);
        return { available: true, candidates: buildCandidates(entries, { threshold, minSeenCount }), errored, popCapped };
      })();

  const remoteAvailable = !remoteDenied && remote.usable();
  const remoteSection = remoteAvailable
    ? await (async () => {
        const { entries, errored, popCapped } = await remoteRawEntries(remote, scopes, narrow);
        return { available: true, candidates: buildCandidates(entries, { threshold, minSeenCount }), errored, popCapped };
      })()
    : {
        available: false,
        reason: remoteDenied
          ? `disabled by deny constraint (${remoteDenied.source})`
          : remoteUnavailableReason(connection),
      };

  const offlineCount = offlineSection.available ? offlineSection.candidates.length : 0;
  const remoteCount = remoteSection.available ? remoteSection.candidates.length : 0;

  if (args.json) {
    log(
      JSON.stringify(
        {
          root,
          scopes,
          minSeenCount,
          offline: sectionJson(offlineSection),
          remote: sectionJson(remoteSection),
        },
        null,
        2,
      ),
    );
  } else {
    heading('LoreKit invariants candidates');
    log(`  project: ${c.dim(root)}`);
    log(`  scopes:  ${scopes.join('  →  ')}`);
    log(`  ${c.dim(`criteria: summed seen_count >= ${minSeenCount}, or a member's meta status is non-"active"`)}`);

    if (offlineSection.available && offlineSection.popCapped) {
      log(`  ${c.yellow('!')} population cap (${POP_CAP}) reached for Offline — results are partial. Narrow with --key-prefix, --since, or --max.`);
    }
    if (remoteSection.available && remoteSection.popCapped) {
      log(`  ${c.yellow('!')} population cap (${POP_CAP}) reached for Remote — results are partial. Narrow with --key-prefix, --since, or --max.`);
    }

    renderSection({ title: 'Offline' }, offlineSection);
    renderSection({ title: 'Remote', subtitle: remoteAvailable ? connection.endpoint : undefined }, remoteSection);

    log('');
    const total = offlineCount + remoteCount;
    if (total === 0) {
      log(`  ${c.green('✓')} no compile candidates at this threshold`);
    } else {
      const plural = total === 1 ? '' : 's';
      log(`  ${c.yellow('!')} ${total} candidate${plural} found — nothing here compiles or gates on its own; write an obligations-map.mjs entry by hand`);
    }
    log('');
  }

  return {
    exitCode: 0,
    'lorekit.cli.invariants.candidates.scope_count': scopes.length,
    'lorekit.cli.invariants.candidates.offline_count': offlineCount,
    'lorekit.cli.invariants.candidates.remote_count': remoteCount,
    'lorekit.cli.invariants.candidates.remote_available': remoteAvailable,
  };
}

function renderSection(header, section) {
  heading(header.title);
  if (header.subtitle) log(`  ${c.dim(header.subtitle)}`);

  if (!section.available) {
    status('warn', 'unavailable', section.reason);
    return;
  }

  for (const e of section.errored || []) {
    log(`  ${c.bold(e.scope)}  ${c.yellow('!')} ${c.dim(e.error)}`);
  }

  if (!section.candidates.length) {
    if (!(section.errored || []).length) log(`  ${c.dim('no compile candidates')}`);
    return;
  }

  let n = 0;
  for (const cand of section.candidates) {
    n += 1;
    log(`  ${c.yellow('•')} candidate ${n} ${c.dim(`(score ${cand.score}, ${cand.members.length} memories)`)}`);
    if (cand.recurrenceClass?.classId) {
      const pureTag = cand.recurrenceClass.pure ? ' — pure' : ' — partial';
      log(`    ${c.dim(`class: ${cand.recurrenceClass.className}${pureTag}`)}`);
    }
    for (const m of cand.members) {
      const fields = [`seen_count=${m.seenCount}`];
      if (m.meta.status) fields.push(`status=${m.meta.status}`);
      if (m.meta['trigger-context']) fields.push(`trigger-context=${JSON.stringify(m.meta['trigger-context'])}`);
      log(`    ${c.cyan('-')} ${m.scope}::${m.key}  ${c.dim(`(${fields.join(', ')})`)}`);
    }
  }
}

function sectionJson(section) {
  if (!section.available) {
    return { available: false, reason: section.reason, candidates: [], errored: [] };
  }
  return { available: true, candidates: section.candidates, errored: section.errored || [] };
}

export async function invariants(args) {
  const sub = args._[1];
  if (sub === 'candidates') return candidates(args);

  err(`${c.red('Usage:')} lorekit invariants <candidates> [options]`);
  return { exitCode: 1 };
}
