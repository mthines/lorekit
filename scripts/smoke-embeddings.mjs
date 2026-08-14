#!/usr/bin/env node
/**
 * Live embedding smoke — proves the pipeline against a REAL project and a REAL
 * provider, then removes everything it wrote.
 * ------------------------------------------------------------------------
 * MANUAL AND ON DEMAND. Not a CI gate, not a deploy step, nothing schedules it:
 * it spends money at a third-party endpoint. Run it after enabling embedding on
 * a project, and after any change to the provider, the model or the write path.
 *
 *   node scripts/smoke-embeddings.mjs
 *   node scripts/smoke-embeddings.mjs --keep      # leave the artefacts behind
 *
 * The offline counterpart is `scripts/backfill-embeddings.smoke.test.mjs`,
 * which drives the same script against a fake provider and covers every failure
 * mode deterministically. That one runs anywhere and costs nothing; THIS one
 * exists to catch what a fake cannot: a wrong model name, a revoked key, a
 * provider that changed its response shape, a column width that does not match
 * what the model actually emits, and RLS or grants that only exist in the real
 * database.
 *
 * Environment (all required):
 *   SUPABASE_URL                Project URL
 *   SUPABASE_SERVICE_ROLE_KEY   Service role
 *   LOREKIT_EMBEDDING_ENABLED   Must be true/1/yes/on
 *   LOREKIT_EMBEDDING_API_KEY   Provider key
 * Optional: LOREKIT_EMBEDDING_MODEL, LOREKIT_EMBEDDING_ENDPOINT
 *
 * CLEANUP IS THE POINT, not an afterthought. This writes to a live tenant, so
 * every artefact is minted through the same namespace contract the other live
 * suites use (`packages/mcp-server/src/smoke-cleanup.ts`): the name is
 * registered AT MINT TIME, carries a timestamp, and matches
 * `SMOKE_ARTEFACT_PATTERN` — so even a run that crashes before cleanup is
 * recognisable to `scripts/smoke-cleanup.mjs`, which sweeps orphans by name.
 * Deletion is a HARD delete (`force=true`); the default is a soft archive,
 * which would leave a row behind on every run forever.
 */
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const {
  resolveEmbeddingConfig, embeddingInput, buildEmbeddingRequest, EMBEDDING_DIMENSIONS, redactKey,
} = await import(path.join(HERE, '..', 'packages', 'mcp-core', 'src', 'embedding.ts'));
const {
  createSmokeNamespace, sweepSmokeArtefacts,
} = await import(path.join(HERE, '..', 'packages', 'mcp-server', 'src', 'smoke-cleanup.ts'));

// The label is part of the CLOSED set in `SMOKE_ARTEFACT_PATTERN`. Minting
// outside it would produce a name the orphan sweeper never recognises, so this
// string cannot be changed here alone — see the pattern's docblock.
const LABEL = 'embed';
// The SHARED namespace, not a local `${LABEL}-smoke-${Date.now()}` plus a local
// array. Building the name here would reproduce the prefix and the mint
// registry while dropping the two checks that make them worth having: the label
// must be in the closed set, and EVERY suffix must stay inside `[a-z0-9-]`. A
// suffix with an underscore or a capital mints a name `SMOKE_ARTEFACT_PATTERN`
// never matches, which is not a failed run — it is a row left in a live tenant
// that nothing will ever sweep.
const ns = createSmokeNamespace(LABEL);
const PREFIX = ns.prefix;
const SCOPE = 'global';

const log = (...p) => process.stdout.write(`${p.join(' ')}\n`);
const mint = (suffix) => ns.name(suffix);

async function rest(base, key, pathAndQuery, init = {}) {
  const res = await fetch(`${base}/rest/v1${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${init.method || 'GET'} ${pathAndQuery} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const keep = process.argv.includes('--keep');
  const env = process.env;
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const config = resolveEmbeddingConfig(env);

  if (!base || !key) { log('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); return 1; }
  if (!config.enabled) {
    log('Embedding is disabled. Set LOREKIT_EMBEDDING_ENABLED=true and LOREKIT_EMBEDDING_API_KEY.');
    log('This script deliberately does NOT run against a disabled project — it is here to prove');
    log('the live path works, and a skipped run that reports success is worse than no run.');
    return 1;
  }

  let failures = 0;
  const check = (ok, label, detail = '') => {
    log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  log(`live embedding smoke · ${PREFIX}`);
  log(`  model: ${config.model}`);
  log('');

  try {
    // ── 1. the provider actually answers, at the width the column expects ────
    // Checked FIRST and directly, because every later failure would otherwise
    // look the same as this one — and this is the failure that a fake provider
    // can never catch (a wrong model name, a revoked key, a model whose real
    // output width is not what the column is declared at).
    const probeText = embeddingInput({ key: mint('probe'), value: 'A probe lesson for the live embedding smoke.' });
    const t0 = Date.now();
    let vector = null;
    // The failure detail is CARRIED, not reported here: `provider responds` is
    // one check with one outcome, and reporting it from the catch as well would
    // print the same label twice and count a single provider failure twice.
    let probeError = null;
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        // The SHARED builder, not a hand-rolled body. `dimensions` is only
        // legal on the `text-embedding-3-*` family (`acceptsDimensionsParam`),
        // so sending it unconditionally 400s on exactly the ada-002 and
        // compatible endpoints `docs/embeddings.md` calls swappable — and the
        // probe would fail on a provider the product itself handles. The smoke
        // must send the request the write path sends.
        body: JSON.stringify(buildEmbeddingRequest([probeText], config)),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${redactKey((await res.text()).slice(0, 200), config.apiKey)}`);
      vector = (await res.json())?.data?.[0]?.embedding ?? null;
    } catch (e) {
      probeError = redactKey(String(e?.message ?? e), config.apiKey);
    }
    const latencyMs = Date.now() - t0;
    check(
      Array.isArray(vector),
      'provider responds',
      Array.isArray(vector) ? `${latencyMs}ms` : (probeError ?? 'no embedding in the response body'),
    );
    check(
      Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS,
      `provider emits ${EMBEDDING_DIMENSIONS} dimensions`,
      Array.isArray(vector) ? `got ${vector.length}` : 'no vector',
    );

    // ── 2. the column round-trips a real vector ─────────────────────────────
    // Proves the declared width, the both-or-neither CHECK and the grants
    // together, against the real database rather than a migration file.
    const writeKey = mint('write');
    if (Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS) {
      await rest(base, key, '/memories', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({
          scope: SCOPE, key: writeKey, value: 'A lesson written by the live embedding smoke.',
          embedding: `[${vector.join(',')}]`, embedding_model: config.model,
        }),
      });
      const [row] = await rest(
        base, key,
        `/memories?select=id,embedding_model&key=eq.${encodeURIComponent(writeKey)}&embedding=not.is.null`,
      );
      check(Boolean(row), 'a real vector round-trips through the column');
      check(row?.embedding_model === config.model, 'embedding_model is stored alongside it');
    }

    // ── 3. the both-or-neither CHECK is live, not just in the migration ─────
    // A vector with no model is unattributable; mixing two models in one column
    // returns confident nonsense across the boundary. This is the guard that
    // stops a future writer doing it, so it is worth proving on the real
    // database — a migration can be applied and a constraint still be absent.
    let refused = false;
    try {
      await rest(base, key, '/memories', {
        method: 'POST',
        body: JSON.stringify({
          scope: SCOPE, key: mint('pairing'), value: 'should be refused',
          embedding: `[${Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0).join(',')}]`,
        }),
      });
    } catch {
      refused = true;
    }
    check(refused, 'a vector with no model is refused by the database');

    log('');
    log(failures === 0 ? `PASS (probe latency ${latencyMs}ms)` : `FAIL — ${failures} check(s) failed`);
  } finally {
    // Always, even on a throw: this wrote to a live tenant.
    const minted = ns.minted();
    if (keep) {
      log(`\n--keep: left ${minted.length} artefact(s) behind under ${PREFIX}`);
    } else {
      // The SHARED sweep, not a local delete loop: it bounds the concurrency so
      // teardown never bursts past the endpoint's rate limit, and it reports in
      // input order regardless of completion order. HARD delete — the default is
      // a soft archive, which would leave a row behind on every run forever,
      // the exact leak the sweeper exists for.
      const { removed, failed } = await sweepSmokeArtefacts(minted, async (name) => {
        await rest(base, key, `/memories?key=eq.${encodeURIComponent(name)}`, { method: 'DELETE' });
      });
      log(`\ncleanup: removed ${removed.length}/${minted.length}`);
      // A leak is a WARNING, never a thrown hook: it must be visible without
      // turning a passing run red, and `scripts/smoke-cleanup.mjs` sweeps by
      // name pattern afterwards regardless.
      if (failed.length) log(`  WARNING: could not remove ${failed.map((f) => f.name).join(', ')} — the sweeper will`);
    }
  }

  return failures === 0 ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => {
  log(`smoke failed: ${String(e?.message ?? e).slice(0, 400)}`);
  process.exit(1);
});
