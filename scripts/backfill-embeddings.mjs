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
 *   normal state here, not an error condition.
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
  resolveEmbeddingConfig, embeddingInput, isEmbeddable, toVectorLiteral,
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
 * The list travels in the query string, so it has to be bounded by something;
 * ~40 characters per uuid entry puts this comfortably inside every proxy's URL
 * limit.
 */
const MAX_SKIP_IDS = 200;

/**
 * A numeric flag's value, or `fallback` when it is missing, non-numeric, or
 * below `min`.
 *
 * `Number(undefined)` is `NaN`, and `NaN` survives a `|| default` guard whose
 * default is falsy — it then reaches PostgREST as the literal text `NaN`, so
 * the bound silently vanishes instead of failing. A NEGATIVE value passes `||`
 * untouched and is just as wrong: a negative `--batch-size` is what `Math.min`
 * returns, and a negative `--sleep-ms` is a no-op pretending to be rate-limit
 * relief. One guard for all three flags rather than a per-flag idiom.
 */
function numArg(raw, { fallback, min = 0 }) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, batchSize: MAX_BATCH_ITEMS, scope: null, sleepMs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--limit') args.limit = numArg(argv[++i], { fallback: null, min: 1 });
    else if (a === '--batch-size') args.batchSize = Math.min(numArg(argv[++i], { fallback: MAX_BATCH_ITEMS, min: 1 }), MAX_BATCH_ITEMS);
    else if (a === '--scope') args.scope = argv[++i];
    else if (a === '--sleep-ms') args.sleepMs = numArg(argv[++i], { fallback: 0, min: 0 });
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  // Rows this RUN cannot process: a batch the provider rejected, and a row with
  // no embeddable text. Both stay `embedding is null`, so without this the next
  // page is the same page — see the properties block above.
  const skipIds = new Set();

  for (;;) {
    if (args.limit != null && done >= args.limit) break;
    const want = args.limit != null ? Math.min(args.batchSize, args.limit - done) : args.batchSize;

    // The exclusion list travels in the URL, so it cannot grow without bound.
    // Stopping is the honest outcome: what is left is what this run has already
    // proven it cannot process, and the counts below tell the operator what to
    // fix before rerunning.
    if (skipIds.size > MAX_SKIP_IDS) {
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
    // still work this run should do.
    if (usable.length === 0) continue;

    for (const group of batchInputs(usable, (u) => u.text, { maxItems: args.batchSize })) {
      batches += 1;
      // The COUNT, not the texts. Retaining every embedded string kept up to
      // MAX_EMBED_CHARS per row alive for the whole run — on a large store the
      // only unbounded allocation in the script — and the cost line only ever
      // needed the total.
      for (const u of group) costChars += u.text.length;

      if (args.dryRun) {
        done += group.length;
        continue;
      }

      try {
        const res = await fetch(config.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify(buildEmbeddingRequest(group.map((u) => u.text), config)),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const vectors = parseEmbeddingResponse(await res.json(), group.length);

        for (let i = 0; i < group.length; i += 1) {
          await rest(
            supabaseUrl, serviceKey,
            `/memories?id=eq.${group[i].row.id}`,
            {
              method: 'PATCH',
              // Both columns in ONE statement — the 00060 CHECK requires
              // both-or-neither, so a split update would be rejected.
              body: JSON.stringify({
                embedding: toVectorLiteral(vectors[i]),
                embedding_model: config.model,
              }),
            },
          );
        }
        done += group.length;
      } catch (e) {
        // Skipped, not fatal: one bad batch must not end a run with thousands
        // of rows left, and these rows stay null for the next one. Excluded from
        // THIS run's queue so a deterministic failure cannot re-serve the same
        // page forever.
        failed += group.length;
        for (const u of group) skipIds.add(u.row.id);
        log(`  batch failed (${group.length} rows), continuing: ${String(e?.message ?? e).slice(0, 200)}`);
      }

      if (args.sleepMs) await sleep(args.sleepMs);
    }

    if (args.dryRun) break; // one page is enough to characterise the cost
  }

  const cost = estimateCostFromChars(costChars, config.usdPerMillionTokens);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  log('');
  log(args.dryRun ? '── dry run (nothing was sent or written) ──' : '── backfill complete ──');
  log(`  rows:      ${done}${failed ? ` (${failed} failed, still null — rerun to retry)` : ''}`);
  if (emptyRows) log(`  unusable:  ${emptyRows} (no embeddable text — these will never be filled)`);
  log(`  batches:   ${batches}`);
  log(`  chars:     ${cost.chars}`);
  log(`  ~tokens:   ${cost.approxTokens}`);
  log(`  est. cost: ${cost.usd == null ? 'unknown (set LOREKIT_EMBEDDING_USD_PER_MTOK)' : `$${cost.usd.toFixed(4)}`}`);
  log(`  elapsed:   ${seconds}s`);
  if (args.dryRun) log('  (one page only — multiply by your pending count for a whole-store estimate)');

  // Exit 0 even with failures: a partially-complete backfill is a normal state
  // here, and the operator has the counts above to decide whether to rerun.
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  log(`backfill failed: ${String(e?.message ?? e).slice(0, 400)}`);
  process.exit(1);
});
