#!/usr/bin/env node
/**
 * Embedding backfill — fills `memories.embedding` for rows that have none.
 * ------------------------------------------------------------------------
 * MANUAL AND ON DEMAND. This is deliberately not wired into any CI gate or
 * deploy step: it spends money at a third-party endpoint and its runtime scales
 * with the store, so it is a thing a human runs and watches, like the eval
 * harness. Nothing schedules it.
 *
 * It is the other half of the write path. `embed-on-write.ts` embeds new
 * memories as they arrive; this covers everything written before embedding was
 * enabled, plus anything whose on-write attempt failed (a provider blip leaves
 * the column null, so the row simply reappears here on the next run).
 *
 *   node scripts/backfill-embeddings.mjs --dry-run     # plan + cost, no calls
 *   node scripts/backfill-embeddings.mjs --limit 500   # bounded first run
 *   node scripts/backfill-embeddings.mjs               # to completion
 *
 * Environment:
 *   SUPABASE_URL                    Project URL (https://<ref>.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY       Service role — reads and writes every tenant
 *   LOREKIT_EMBEDDING_API_KEY       Provider key. NEVER committed.
 *   LOREKIT_EMBEDDING_ENABLED       Must be true/1/yes/on, same as the edge
 *   LOREKIT_EMBEDDING_MODEL         Default text-embedding-3-small
 *   LOREKIT_EMBEDDING_ENDPOINT      Default https://api.openai.com/v1/embeddings
 *   LOREKIT_EMBEDDING_USD_PER_MTOK  Price, for the cost line. Reported only.
 *
 * Flags:
 *   --dry-run              Plan and cost only. No provider call, no write.
 *   --limit <n>            Stop after n rows (default: no limit).
 *   --batch-size <n>       Rows per provider request (default 96, capped).
 *   --scope <s>            Only rows in this exact scope.
 *   --sleep-ms <n>         Pause between batches (default 0). Rate-limit relief.
 *
 * PROPERTIES THIS SCRIPT IS BUILT AROUND:
 *
 *   IDEMPOTENT AND RESUMABLE, with no state of its own. The work queue is a
 *   query — `embedding is null` — so an interrupted run leaves the store in a
 *   valid state and the next run simply picks up what is left. There is no
 *   cursor file to go stale and no way for a crash to skip a row.
 *
 *   IT PAGES BY RE-QUERYING, NOT BY OFFSET. Each batch asks again for rows with
 *   no embedding, so rows this run has already filled fall out of the result
 *   naturally. An OFFSET-based walk over a set the run is mutating skips rows,
 *   silently, and the gap is invisible afterwards.
 *
 *   A FAILED BATCH IS SKIPPED, NOT FATAL. One provider error (a too-long input,
 *   a transient 5xx) must not end a run that has thousands of rows left. The
 *   failures are counted and reported, and those rows stay null for the next
 *   run. `--strict` is deliberately absent: a partially-complete backfill is a
 *   normal state here, not an error condition. The failure UNIT differs by
 *   phase: the embed call is all-or-nothing for its group (no vectors, no
 *   writes), while the row writes settle individually, so a row that landed is
 *   counted `done` even when a sibling in the same group rejects.
 *
 *   A ROW THIS RUN CANNOT PROCESS IS EXCLUDED FROM THE QUEUE, NOT JUST SKIPPED.
 *   The queue is the query `embedding is null`, so a row the run leaves null is
 *   a row the next page returns again. Across RUNS that is the feature (the next
 *   run retries a transient failure); within ONE run it is a livelock — a
 *   deterministic failure (revoked key, unusable model, an input the provider
 *   always rejects) re-fetches the identical page and fails it forever. The same
 *   shape sits one branch over: a row with no embeddable text can never leave the
 *   queue either, and a page made entirely of them used to end the run early
 *   while embeddable rows were still waiting further down the ordering. Both go
 *   into one `skipIds` set that the query excludes, so every pass either makes
 *   progress or terminates.
 *
 *   IT NEVER PRINTS THE KEY. Provider error bodies are truncated and the key
 *   only ever travels in a header.
 *
 * Zero-dependency: node builtins plus the repo's own pure module.
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The pure module is imported rather than re-implemented, so the script and the
// edge write path cannot disagree about what text a memory embeds as or whether
// a provider response is trustworthy — the two most expensive things to get
// subtly different. It is TypeScript, which Node executes directly from v22.18 /
// v23.6 onward (type stripping); there is no build step to run first.
const MODULE = path.join(HERE, '..', 'packages', 'mcp-core', 'src', 'embedding.ts');
const {
  resolveEmbeddingConfig, embeddingInput, isEmbeddable, toVectorLiteral, redactKey,
  buildEmbeddingRequest, parseEmbeddingResponse, batchInputs, estimateCostFromChars,
  MAX_BATCH_ITEMS,
} = await import(MODULE).catch((e) => {
  process.stderr.write(
    `Cannot load ${MODULE}: ${e?.message ?? e}\n`
    + `Node ${process.version} may predate native TypeScript stripping — this script needs `
    + 'Node >= 22.18 (or >= 23.6), the same floor the rest of the repo assumes.\n',
  );
  process.exit(1);
});

/**
 * How many rows this run may carry in its exclusion list before it stops.
 *
 * DERIVED FROM A BYTE BUDGET, not chosen. The list travels in the query string,
 * and the binding constraint is the front proxy's request-LINE limit, which
 * nginx defaults to 8 KB — the tightest hop in front of PostgREST. A uuid plus
 * its comma is 37 bytes, so the arithmetic is:
 *
 *   6144 bytes for the id list        (8 KB, less headroom for the rest of the
 *                                      query: select, filters, order, limit)
 *   ÷ 37 bytes per id                 = 166 ids the URL can actually carry
 *   − MAX_BATCH_ITEMS (96)            = 70
 *
 * The subtraction is the part that is easy to get wrong, and getting it wrong
 * is how the previous value (200) was unsafe: the set can OVERSHOOT this cap by
 * a whole batch before `overSkipCap` fires, because a failed group must be
 * excluded whole or its rows are served again forever. So the cap has to be the
 * budget MINUS the largest possible overshoot, not the budget itself. At 200 the
 * worst case was 296 ids ≈ 11 KB, and a heavily-failing run would have started
 * 414ing instead of stopping cleanly — the failure the cap exists to prevent,
 * arriving by a different door.
 */
const MAX_SKIP_IDS = 70;

/**
 * A numeric flag's value, or `null` when it is missing, non-numeric, or below
 * `min`.
 *
 * `Number(undefined)` is `NaN`, and `NaN` survives a `|| default` guard whose
 * default is falsy — it then reaches PostgREST as the literal text `NaN`, so
 * the bound silently vanishes instead of failing. A NEGATIVE value passes `||`
 * untouched and is just as wrong: a negative `--batch-size` is what `Math.min`
 * returns, and a negative `--sleep-ms` is a no-op pretending to be rate-limit
 * relief. One guard for all three flags rather than a per-flag idiom.
 *
 * IT RETURNS `null` RATHER THAN A FALLBACK, AND THAT IS THE POINT. A guard that
 * hands back a safe default cannot distinguish "the operator asked for this
 * value" from "the operator typed something this script could not read", so
 * `--sleep-ms abc` became `0` — the requested rate-limit relief silently
 * deleted on the one flag whose entire purpose is slowing a paid run, and
 * `--batch-size abc` silently promoted to the maximum. A safe fallback makes a
 * MISSING value safe; it never makes a MALFORMED one correct, because a
 * malformed value is a typo and a typo has an author to tell. `--limit` and
 * `--scope` already reported a usage error for exactly this shape; every
 * value-taking flag now answers the same way.
 *
 * The two questions stay separate: `isMissingValue` asks "is this a value at
 * all, or the next flag", this asks "is this value well-formed for this flag",
 * and `parseArgs` owns what an absent flag MEANS (no limit, every scope, a
 * default batch size, no sleep).
 */
function numArg(raw, { min = 0 }) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return null;
  return Math.floor(n);
}

/** How a malformed value is reported, identically for every flag that takes one. */
function badValueError(flag, raw, what) {
  return `${flag} needs ${what} (got "${raw}").`;
}

/** `true` when `raw` cannot be a flag's value: absent, blank, or the next flag. */
function isMissingValue(raw) {
  return raw === undefined || raw.startsWith('--') || raw.trim() === '';
}

/** How a missing value is reported, identically for every flag that takes one. */
function missingValueError(flag, raw, what) {
  return `${flag} needs ${what} (got ${raw === undefined ? 'nothing' : `"${raw}"`}).`;
}

/**
 * Every flag this script accepts. An argument that is not in this set is a
 * usage error, never ignored: a typo used to fall through the `if/else` chain
 * silently, so `--scpoe personal` ran every scope and `--dry-runn` billed a
 * real run — the loudest possible failures, reported as none at all.
 */
const KNOWN_FLAGS = new Set(['--dry-run', '--limit', '--batch-size', '--scope', '--sleep-ms']);

/**
 * Exported for `backfill-embeddings.test.mjs`. This is the one function in the
 * script that decides what a paid run touches and how much it spends, and it
 * has taken four rounds of usage-error hardening — every one of which was a
 * REVIEW finding rather than a failing test, because nothing executed it. The
 * `invokedDirectly` seam at the bottom (the `check-migration-order.mjs`
 * pattern) is what lets a test import it without the script running.
 */
export function parseArgs(argv) {
  const args = { dryRun: false, limit: null, batchSize: MAX_BATCH_ITEMS, scope: null, sleepMs: 0, error: null };
  const fail = (message) => { args.error = message; return args; };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === '--dry-run') { args.dryRun = true; continue; }

    if (!KNOWN_FLAGS.has(a)) {
      return fail(`unknown argument "${a}". Accepted flags: ${[...KNOWN_FLAGS].join(', ')}.`);
    }

    // EVERY value-taking flag consumes its argument through the same guard, and
    // EVERY one reports a usage error for a value it cannot read. Without the
    // first, `--batch-size --scope personal` swallows `--scope` and the run
    // silently widens to every scope; without the second, `--sleep-ms abc`
    // silently becomes `0`. A default is how an OMITTED flag stays safe — it is
    // never how a typo is answered, because a typo has an author to tell.
    const raw = argv[++i];

    if (a === '--limit') {
      // `--limit` is the flag whose ABSENCE is not safe: omitting it means "no
      // limit", so `--limit 0`, a negative, or a typo must never be allowed to
      // promote a bounded run that spends money into an unbounded one. The
      // other flags are bounded either way; this one is the reason the whole
      // parser refuses rather than defaults.
      if (isMissingValue(raw)) {
        return fail(`${missingValueError('--limit', raw, 'a positive integer')} `
          + 'It is the only flag that bounds what a run spends, so it is never defaulted away — omit it for no limit.');
      }
      const n = numArg(raw, { min: 1 });
      if (n == null) {
        return fail(`${badValueError('--limit', raw, 'a positive integer')} `
          + 'It is the only flag that bounds what a run spends, so it is never defaulted away — omit it for no limit.');
      }
      args.limit = n;
    } else if (a === '--scope') {
      // The default here (`null` = EVERY scope) widens the run rather than
      // bounding it, so a missing value is never assumed.
      if (isMissingValue(raw)) {
        return fail(`${missingValueError('--scope', raw, 'a scope string')} `
          + 'Omitting it is how you ask for every scope, so a missing value is never assumed.');
      }
      args.scope = raw;
    } else if (a === '--batch-size') {
      if (isMissingValue(raw)) return fail(missingValueError('--batch-size', raw, 'a positive integer'));
      const n = numArg(raw, { min: 1 });
      if (n == null) return fail(badValueError('--batch-size', raw, 'a positive integer'));
      args.batchSize = Math.min(n, MAX_BATCH_ITEMS);
    } else if (a === '--sleep-ms') {
      if (isMissingValue(raw)) return fail(missingValueError('--sleep-ms', raw, 'a non-negative integer'));
      const n = numArg(raw, { min: 0 });
      if (n == null) return fail(badValueError('--sleep-ms', raw, 'a non-negative integer'));
      args.sleepMs = n;
    }
  }
  return args;
}

/** Concurrent row writes per batch. Enough to hide the round-trip latency, few
 *  enough to stay polite to PostgREST's connection pool. */
const WRITE_CONCURRENCY = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` over every item with at most `limit` in flight, SETTLING each item
 * independently. Returns one index-aligned entry per item: `{ ok: true }`, or
 * `{ ok: false, error }`.
 *
 * `Promise.all` semantics were wrong here for an accounting reason, not a
 * throughput one. Making the write phase concurrent moved the failure boundary:
 * the first PATCH rejection abandoned its siblings, so the whole group was
 * counted `failed`, added to `skipIds`, and reported as "still null — rerun to
 * retry" — false for every row that had already been written. A concurrency
 * change is an accounting change; settle per item and count per item.
 */
async function mapSettled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      try {
        await fn(items[i], i);
        results[i] = { ok: true };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function log(...parts) {
  process.stdout.write(`${parts.join(' ')}\n`);
}

async function rest(base, key, pathAndQuery, init = {}) {
  const res = await fetch(`${base}/rest/v1${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`REST ${init.method || 'GET'} ${pathAndQuery} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    log(args.error);
    return 1;
  }
  const env = process.env;
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const config = resolveEmbeddingConfig(env);

  if (!supabaseUrl || !serviceKey) {
    log('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
    return 1;
  }
  // The dry run deliberately does NOT require the flag or the key: seeing what a
  // backfill would cost is exactly the question you ask BEFORE enabling it.
  if (!config.enabled && !args.dryRun) {
    log('Embedding is disabled. Set LOREKIT_EMBEDDING_ENABLED=true and LOREKIT_EMBEDDING_API_KEY,');
    log('or pass --dry-run to see the plan and the estimated cost without spending anything.');
    return 1;
  }

  const scopeFilter = args.scope ? `&scope=eq.${encodeURIComponent(args.scope)}` : '';

  let done = 0;
  let failed = 0;
  let batches = 0;
  let emptyRows = 0;
  const started = Date.now();
  let costChars = 0;
  // A new terminal state owes the summary a new headline: the `MAX_SKIP_IDS`
  // break exits with work still queued, and printing `── backfill complete ──`
  // there would tell an operator the store is done when it is not.
  let stoppedEarly = false;
  // `stoppedEarly` is not the only way a run ends with work left. `failed > 0`
  // is the SAME state — those rows are still null and a rerun retries them — so
  // the headline is driven by "is there retryable work", not by which break
  // fired. `emptyRows` is deliberately excluded: a row with no embeddable text
  // will never be filled, so a rerun would change nothing.
  const workRemains = () => stoppedEarly || failed > 0;

  // Rows this RUN cannot process: a batch the provider rejected, and a row with
  // no embeddable text. Both stay `embedding is null`, so without this the next
  // page is the same page — see the properties block above.
  const skipIds = new Set();

  // Checked wherever `skipIds` GROWS, not only between pages. The exclusion
  // list travels in the URL, and the growth sites are inside a page — a page of
  // unembeddable rows, then one add per failed batch — so a between-pages-only
  // check let the set reach the cap PLUS a whole page before anything fired,
  // overshooting the URL budget this cap exists to protect.
  //
  // Stopping early also stops SPENDING: without this the run kept embedding the
  // remainder of a page it had already decided to abandon.
  //
  // The residual overshoot is one batch group, and it is irreducible — a failed
  // group must be excluded whole or its rows are served again forever, which is
  // the livelock this set exists to prevent. So the worst case the URL must
  // carry is `MAX_SKIP_IDS + args.batchSize`, which is exactly what MAX_SKIP_IDS
  // is derived to leave room for — see its docblock.
  const overSkipCap = () => skipIds.size > MAX_SKIP_IDS;

  for (;;) {
    if (args.limit != null && done >= args.limit) break;
    const want = args.limit != null ? Math.min(args.batchSize, args.limit - done) : args.batchSize;

    // Stopping is the honest outcome: what is left is what this run has already
    // proven it cannot process, and the counts below tell the operator what to
    // fix before rerunning. `overSkipCap` is also checked at each growth site
    // inside the page below — this one catches a run that arrives here already
    // over, so the two together bound the URL.
    if (overSkipCap()) {
      stoppedEarly = true;
      log(`  stopping: ${skipIds.size} row(s) could not be processed this run (see counts below)`);
      break;
    }
    const skipFilter = skipIds.size > 0 ? `&id=not.in.(${[...skipIds].join(',')})` : '';

    // RE-QUERY, never offset: rows filled by this run drop out of the result on
    // their own, and an offset walk over a set being mutated skips rows.
    const rows = await rest(
      supabaseUrl, serviceKey,
      `/memories?select=id,key,value&embedding=is.null&archived_at=is.null${scopeFilter}${skipFilter}`
      + `&order=created_at.desc&limit=${want}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) break;

    const usable = rows
      .map((r) => ({ row: r, text: embeddingInput(r) }))
      .filter((r) => isEmbeddable(r.text));

    // A row whose text is empty can never be embedded. It is reported and left
    // alone — an empty memory is a lint finding, not a backfill's problem to fix
    // — but it is excluded from the queue, or a page made of them comes back
    // unchanged for the rest of the run.
    const empty = rows.length - usable.length;
    if (empty > 0) {
      emptyRows += empty;
      for (const r of rows) if (!isEmbeddable(embeddingInput(r))) skipIds.add(r.id);
      log(`  skipped ${empty} row(s) with no embeddable text`);
    }
    // `continue`, not `break`: the embeddable rows further down the ordering are
    // still work this run should do. The outer check at the top of the loop is
    // what sees an oversized set — that is why this returns there rather than
    // falling through.
    if (usable.length === 0) continue;

    // A page of unembeddable rows can pass the cap on its own. Go back to the
    // outer check rather than paying a provider for a page this run is about to
    // abandon — the old code embedded the whole page first and stopped after.
    if (overSkipCap()) continue;

    for (const group of batchInputs(usable, (u) => u.text, { maxItems: args.batchSize })) {
      batches += 1;
      // The COUNT, not the texts. Retaining every embedded string kept up to
      // MAX_EMBED_CHARS per row alive for the whole run — on a large store the
      // only unbounded allocation in the script — and the cost line only ever
      // needed the total.
      const groupChars = group.reduce((n, u) => n + u.text.length, 0);

      if (args.dryRun) {
        // A dry run bills the PLAN: nothing is sent, and the whole point is
        // what the run WOULD cost, so every batch counts.
        costChars += groupChars;
        done += group.length;
        continue;
      }

      // The EMBED call is the one all-or-nothing step: no vectors means no row
      // in this group can be written, so the group is the failure unit here.
      let vectors;
      try {
        const res = await fetch(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(buildEmbeddingRequest(group.map((u) => u.text), config)),
          signal: AbortSignal.timeout(60_000),
        });
        // Redacted before it can reach a log: several providers reflect the
        // offending credential in the error body.
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${redactKey((await res.text()).slice(0, 300), config.apiKey)}`);
        }
        vectors = parseEmbeddingResponse(await res.json(), group.length);
      } catch (e) {
        // Skipped, not fatal: one bad batch must not end a run with thousands
        // of rows left, and these rows stay null for the next one. Excluded from
        // THIS run's queue so a deterministic failure cannot re-serve the same
        // page forever.
        failed += group.length;
        for (const u of group) skipIds.add(u.row.id);
        log(`  batch failed (${group.length} rows), continuing: ${String(e?.message ?? e).slice(0, 200)}`);
        // Leave the PAGE, not just this group, once the cap is passed. A run
        // failing every batch would otherwise keep calling a provider that is
        // rejecting it — paying for each attempt — until the page ran out.
        if (overSkipCap()) break;
        if (args.sleepMs) await sleep(args.sleepMs);
        continue;
      }

      // Charged only once the provider ACCEPTED the batch. Counting before the
      // call billed the run for text it never embedded, so a run with rejected
      // batches reported a cost the invoice will not show. A write that fails
      // afterwards still counts: the tokens were spent either way.
      costChars += groupChars;

      // The WRITE phase is per row, and so is its accounting. Concurrent, not
      // serial: one awaited PATCH per row made the write phase dominate a large
      // run and undid the batching the embed call just did. Settled, not
      // all-or-nothing: a row that was written is `done`, never `failed`, even
      // when a sibling in the same group rejects.
      //
      // A single BULK upsert per batch is not reachable from here. `memories`
      // is arbitrated by PARTIAL unique indexes (`where archived_at is null`,
      // 00003/00016) that PostgREST's `upsert(onConflict)` cannot target —
      // which is why `memory_write` exists — and an id-keyed upsert would have
      // to carry every NOT NULL column, so a payload of just the two embedding
      // columns would clobber scope/key/value. A bounded pool buys the same
      // wall-clock win with the same statements.
      const writes = await mapSettled(group, WRITE_CONCURRENCY, async (u, i) => {
        const patched = await rest(
          supabaseUrl, serviceKey,
          // `select=id` shapes the returned representation down to one column.
          // Without it `return=representation` echoes the whole row back —
          // including the 1536-float vector just written, per row, for nothing.
          `/memories?id=eq.${u.row.id}&select=id`,
          {
            method: 'PATCH',
            // `return=representation` is not decoration: a PATCH that matches
            // ZERO rows succeeds with 204 and an empty body, which `rest` reads
            // as success — so a row that was never written was counted `done`
            // and reported as embedded while still null. That is the same silent
            // zero-row shape 00062 removes from the edge path, and it was
            // sitting here too. Asking for the affected rows is what makes the
            // difference observable at all.
            headers: { prefer: 'return=representation' },
            // Both columns in ONE statement — the 00060 CHECK requires
            // both-or-neither, so a split update would be rejected.
            body: JSON.stringify({
              embedding: toVectorLiteral(vectors[i]),
              embedding_model: config.model,
            }),
          },
        );
        // Thrown, not returned: `mapSettled` counts a throw as this row's
        // failure, which puts it in `failed` and `skipIds` where it belongs —
        // the row really is still null and really will be retried next run.
        if (!Array.isArray(patched) || patched.length === 0) {
          throw new Error(`write matched no row (id=${u.row.id})`);
        }
      });

      const written = writes.filter((w) => w.ok).length;
      done += written;
      if (written < group.length) {
        // Only the rows that actually failed leave the queue: a written row is
        // no longer `embedding is null`, and excluding a row this run succeeded
        // on would be a lie in both the counts and the exclusion list.
        const firstError = writes.find((w) => !w.ok)?.error;
        for (let i = 0; i < group.length; i += 1) if (!writes[i].ok) skipIds.add(group[i].row.id);
        failed += group.length - written;
        log(`  ${group.length - written} of ${group.length} row write(s) failed, continuing: ${String(firstError?.message ?? firstError).slice(0, 200)}`);
        // The THIRD growth site, and the docblock promises a check at every one.
        // Without it a page whose writes all fail keeps embedding its remaining
        // groups — paying the provider each time — for rows it is about to
        // exclude anyway. Same reasoning as the embed-failure break above.
        if (overSkipCap()) break;
      }

      if (args.sleepMs) await sleep(args.sleepMs);
    }

    if (args.dryRun) break; // one page is enough to characterise the cost
  }

  const cost = estimateCostFromChars(costChars, config.usdPerMillionTokens);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  log('');
  log(args.dryRun
    ? '── dry run (nothing was sent or written) ──'
    : stoppedEarly
      ? '── backfill stopped early (work remains) ──'
      : workRemains()
        ? '── backfill incomplete (work remains) ──'
        : '── backfill complete ──');
  log(`  rows:      ${done}${failed ? ` (${failed} failed, still null — rerun to retry)` : ''}`);
  if (emptyRows) log(`  unusable:  ${emptyRows} (no embeddable text — these will never be filled)`);
  log(`  batches:   ${batches}`);
  log(`  chars:     ${cost.chars}`);
  log(`  ~tokens:   ${cost.approxTokens}`);
  log(`  est. cost: ${cost.usd == null ? 'unknown (set LOREKIT_EMBEDDING_USD_PER_MTOK)' : `$${cost.usd.toFixed(4)}`}`);
  log(`  elapsed:   ${seconds}s`);
  if (stoppedEarly) {
    log(`  stopped:   ${skipIds.size} unprocessable row(s) passed the ${MAX_SKIP_IDS} cap — rows are still`);
    log('             waiting; fix the cause above and rerun to pick them up.');
  }
  if (args.dryRun) log('  (one page only — multiply by your pending count for a whole-store estimate)');

  // Exit 0 even with failures: a partially-complete backfill is a normal state
  // here, and the operator has the counts above to decide whether to rerun.
  return 0;
}

// Run the backfill only when invoked as a script, not when imported by a test.
// The `check-migration-order.mjs` seam: without it, importing this module to
// unit-test `parseArgs` would start a real, paid run.
const invokedDirectly = process.argv[1] && /backfill-embeddings\.mjs$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then((code) => process.exit(code), (e) => {
    log(`backfill failed: ${String(e?.message ?? e).slice(0, 400)}`);
    process.exit(1);
  });
}
