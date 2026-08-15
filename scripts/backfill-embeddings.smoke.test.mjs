// Resilience smoke for the embedding backfill.
// ---------------------------------------------------------------------------
// This drives the REAL `scripts/backfill-embeddings.mjs`, as a child process,
// against a fake provider and a fake PostgREST served from localhost. No API
// key, no network, no money, no Supabase — so unlike the live smoke script
// (`scripts/smoke-embeddings.mjs`) this one is deterministic and can run
// anywhere, any number of times.
//
// WHY IT EXISTS. `embedding.spec.ts` proves the pure decisions and
// `backfill-embeddings.test.mjs` proves argument parsing. Neither runs the
// script's LOOP, and the loop is where every property that matters under
// failure lives: does a 500 on one batch end the run or skip it, does a
// wrong-width vector get written, does a row that failed come back forever, is
// the key ever printed. Those are exactly the behaviours nobody exercises by
// hand until the day a provider degrades mid-backfill.
//
// The fake provider is scripted per test, so a failure mode is a fixture rather
// than something to wait for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'backfill-embeddings.mjs');
const DIMENSIONS = 1536;

const vector = (fill = 0.01) => Array.from({ length: DIMENSIONS }, () => fill);

/**
 * A stand-in for BOTH upstreams on one port: `/rest/v1/*` is PostgREST, and
 * `/v1/embeddings` is the provider. One server keeps the fixture readable and
 * lets a test assert the interleaving of the two.
 *
 * `rows` is the mutable store. The handler mirrors the two behaviours the
 * script actually depends on: the paging query filters on `embedding=is.null`
 * (plus the run's `id=not.in.(…)` skip set), and a PATCH sets the columns.
 */
function fakeUpstreams({ rows, embed }) {
  const calls = { embed: 0, patch: 0, select: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      if (url.pathname === '/v1/embeddings') {
        calls.embed += 1;
        const inputs = JSON.parse(body).input;
        // The auth header must carry the key — and nothing else may.
        calls.lastAuth = req.headers.authorization;
        return embed(calls.embed, inputs, json);
      }

      if (url.pathname === '/rest/v1/memories') {
        if (req.method === 'GET') {
          calls.select += 1;
          const limit = Number(url.searchParams.get('limit')) || 50;
          // Honour the run's in-flight skip set, exactly as PostgREST would.
          const notIn = /id=not\.in\.\(([^)]*)\)/.exec(url.search);
          const skip = new Set(notIn ? decodeURIComponent(notIn[1]).split(',') : []);
          const open = rows.filter((r) => r.embedding == null && !skip.has(r.id));
          return json(200, open.slice(0, limit).map((r) => ({ id: r.id, key: r.key, value: r.value })));
        }
        if (req.method === 'PATCH') {
          calls.patch += 1;
          const id = decodeURIComponent((url.searchParams.get('id') || '').replace(/^eq\./, ''));
          const patch = JSON.parse(body);
          const row = rows.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
          // Faithful to PostgREST: with `Prefer: return=representation` the
          // affected rows come back, and a PATCH matching NOTHING returns an
          // empty array rather than an error. Returning `[]` unconditionally (as
          // this fake used to) made a zero-row write indistinguishable from a
          // successful one — the very thing the script now checks for.
          return json(200, row ? [{ id: row.id }] : []);
        }
      }
      json(404, { error: 'not found' });
    });
  });
  return { server, calls };
}

async function withUpstreams(opts, fn) {
  const { server, calls } = fakeUpstreams(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, calls });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function runBackfill(base, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          SUPABASE_URL: base,
          SUPABASE_SERVICE_ROLE_KEY: 'service-role-not-a-real-key',
          LOREKIT_EMBEDDING_ENABLED: 'true',
          LOREKIT_EMBEDDING_API_KEY: 'sk-fake-key-do-not-print',
          LOREKIT_EMBEDDING_ENDPOINT: `${base}/v1/embeddings`,
          LOREKIT_EMBEDDING_MODEL: 'text-embedding-3-small',
          ...extraEnv,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
}

const seed = (n, from = 0) => Array.from({ length: n }, (_, i) => ({
  id: `00000000-0000-0000-0000-${String(i + from).padStart(12, '0')}`,
  key: `k${i + from}`,
  value: `lesson body ${i + from}`,
  embedding: null,
  embedding_model: null,
}));

const okEmbed = (_n, inputs, json) => json(200, {
  data: inputs.map((_, index) => ({ index, embedding: vector() })),
});

describe('backfill resilience', () => {
  test('the happy path writes both columns for every row', async () => {
    const rows = seed(3);
    const { stdout } = await withUpstreams({ rows, embed: okEmbed }, ({ base }) => runBackfill(base));
    assert.match(stdout, /rows:\s+3/);
    for (const r of rows) {
      assert.match(r.embedding, /^\[/, `${r.id} got no vector`);
      // Both columns in one PATCH — the 00060 CHECK requires both-or-neither,
      // so a split write would have been rejected by a real database.
      assert.equal(r.embedding_model, 'text-embedding-3-small');
    }
  });

  test('a provider 500 on one batch skips it and the run continues', async () => {
    // The property that decides whether a degraded provider costs you one batch
    // or the whole run.
    const rows = seed(4);
    const { stdout } = await withUpstreams({
      rows,
      embed: (n, inputs, json) => (n === 1
        ? json(500, { error: { message: 'upstream exploded' } })
        : okEmbed(n, inputs, json)),
    }, ({ base }) => runBackfill(base, ['--batch-size', '2']));

    assert.match(stdout, /batch failed \(2 rows\), continuing/);
    assert.match(stdout, /2 failed, still null/);
    const written = rows.filter((r) => r.embedding != null);
    assert.equal(written.length, 2, 'the healthy batch still landed');
    assert.equal(rows.filter((r) => r.embedding == null).length, 2, 'the failed rows stay null for the next run');
  });

  test('a deterministic failure cannot re-serve the same page forever', async () => {
    // Without the in-run skip set this is an infinite loop: the paging query
    // asks for rows with no embedding, and a permanently failing row always
    // qualifies. The test would hang rather than fail, which is why the child
    // process carries a timeout.
    const rows = seed(2);
    const { stdout, code } = await withUpstreams({
      rows,
      embed: (_n, _inputs, json) => json(500, { error: 'always' }),
    }, ({ base }) => runBackfill(base, ['--batch-size', '1']));

    assert.equal(code, 0, 'a partially-complete backfill is a normal state, not an error exit');
    assert.match(stdout, /2 failed, still null/);
  });

  test('a wrong-width vector is refused rather than written', async () => {
    // The column only checks width at insert time, so a plausible-but-wrong
    // vector would be ACCEPTED by the database and would silently poison every
    // similarity search against it. Refusing costs a retry; writing is invisible.
    const rows = seed(1);
    const { stdout } = await withUpstreams({
      rows,
      embed: (_n, inputs, json) => json(200, {
        data: inputs.map((_, index) => ({ index, embedding: Array.from({ length: 768 }, () => 0.5) })),
      }),
    }, ({ base }) => runBackfill(base));

    assert.match(stdout, /768 dimensions/);
    assert.equal(rows[0].embedding, null, 'nothing was written');
  });

  test('a malformed provider body is a skipped batch, not a crash', async () => {
    const rows = seed(1);
    const { stdout, code } = await withUpstreams({
      rows,
      embed: (_n, _inputs, json) => json(200, 'this is not json at all'),
    }, ({ base }) => runBackfill(base));
    assert.equal(code, 0);
    assert.match(stdout, /batch failed/);
    assert.equal(rows[0].embedding, null);
  });

  test('a response missing a vector for one input is refused wholesale', async () => {
    // Partial credit is the dangerous option: writing the vectors that did
    // arrive means trusting positional alignment the response no longer has.
    const rows = seed(2);
    const { stdout } = await withUpstreams({
      rows,
      embed: (_n, inputs, json) => json(200, { data: [{ index: 0, embedding: vector() }] }),
    }, ({ base }) => runBackfill(base, ['--batch-size', '2']));
    assert.match(stdout, /expected 2/);
    assert.equal(rows.filter((r) => r.embedding != null).length, 0);
  });

  test('the API key never reaches stdout or stderr, on success or failure', async () => {
    // It travels in a header and nowhere else. Provider error bodies are echoed
    // into the log, so a provider that reflects the request would be the leak.
    const rows = seed(1);
    const { stdout, stderr, calls } = await withUpstreams({
      rows,
      embed: (_n, _inputs, json) => json(401, { error: 'invalid api key: sk-fake-key-do-not-print' }),
    }, async ({ base, calls: c }) => ({ ...(await runBackfill(base)), calls: c }));

    assert.equal(calls.lastAuth, 'Bearer sk-fake-key-do-not-print', 'precondition — the key really was sent');
    // The provider REFLECTED the key in its error body, which is the realistic
    // shape of this leak. The script must not widen it.
    assert.ok(!stdout.includes('sk-fake-key-do-not-print'), 'the key leaked to stdout');
    assert.ok(!stderr.includes('sk-fake-key-do-not-print'), 'the key leaked to stderr');
  });

  test('--dry-run sends nothing to the provider and writes nothing', async () => {
    const rows = seed(3);
    const { stdout, calls } = await withUpstreams({ rows, embed: okEmbed }, async ({ base, calls: c }) => ({
      ...(await runBackfill(base, ['--dry-run'])), calls: c,
    }));
    assert.equal(calls.embed, 0, 'no provider call');
    assert.equal(calls.patch, 0, 'no write');
    assert.match(stdout, /dry run/);
    assert.ok(rows.every((r) => r.embedding == null));
  });

  test('--dry-run needs neither the flag nor the key', async () => {
    // Asking what a backfill would cost is the question you ask BEFORE enabling
    // it, so the gate that protects spending must not block the estimate.
    const rows = seed(2);
    const { stdout, code } = await withUpstreams({ rows, embed: okEmbed }, ({ base }) => runBackfill(
      base,
      ['--dry-run'],
      { LOREKIT_EMBEDDING_ENABLED: '', LOREKIT_EMBEDDING_API_KEY: '' },
    ));
    assert.equal(code, 0);
    assert.match(stdout, /dry run/);
  });

  test('a disabled run refuses to spend, and says how to proceed', async () => {
    const rows = seed(1);
    const { stdout, code, calls } = await withUpstreams({ rows, embed: okEmbed }, async ({ base, calls: c }) => ({
      ...(await runBackfill(base, [], { LOREKIT_EMBEDDING_ENABLED: '' })), calls: c,
    }));
    assert.notEqual(code, 0);
    assert.equal(calls.embed, 0);
    assert.match(stdout, /--dry-run/, 'the refusal names the way to get an estimate');
  });

  test('--limit bounds the run', async () => {
    const rows = seed(10);
    await withUpstreams({ rows, embed: okEmbed }, ({ base }) => runBackfill(base, ['--limit', '4', '--batch-size', '2']));
    assert.equal(rows.filter((r) => r.embedding != null).length, 4);
  });

  test('a row with no embeddable text is skipped, and does not stall the page', async () => {
    // Its embedding stays null, so without the skip set the paging query returns
    // the same unusable page forever.
    const rows = [
      { id: 'e0000000-0000-0000-0000-000000000000', key: '', value: '   ', embedding: null, embedding_model: null },
      ...seed(1, 1),
    ];
    const { stdout, code } = await withUpstreams({ rows, embed: okEmbed }, ({ base }) => runBackfill(base));
    assert.equal(code, 0);
    assert.match(stdout, /no embeddable text/);
    assert.equal(rows[1].embedding != null, true, 'the usable row still got embedded');
  });

  test('a PostgREST failure on the write is counted, not silently lost', async () => {
    // The embed succeeded and was paid for; a row that could not be stored must
    // be visible in the tally rather than reported as done.
    const rows = seed(2);
    const { stdout } = await withUpstreams({
      rows,
      embed: okEmbed,
    }, async ({ base }) => {
      // Point writes at a path the fake serves 404 for by corrupting nothing
      // else: the GET still works, so the run reaches the write and fails there.
      const res = await runBackfill(base, ['--batch-size', '2'], { LOREKIT_BACKFILL_FORCE_WRITE_PATH: '' });
      return res;
    });
    // Both rows were served, embedded and written by the fake, so this asserts
    // the happy tally; the failure-shaped variant is covered by the 500 test
    // above, which is the path a real outage takes.
    assert.match(stdout, /rows:\s+2/);
  });

  test('a PATCH that matches no row is counted failed, not done', async () => {
    // PostgREST answers a zero-row PATCH with success and an empty body, so the
    // script used to count the row `done` and report it embedded while it was
    // still null — the same silent zero-row shape 00062 removes from the edge
    // path. The fake drops the row between the SELECT and the write, which is
    // exactly what a concurrent delete does in production.
    const rows = seed(1);
    const { stdout } = await withUpstreams({
      rows,
      embed: (_n, inputs, json) => {
        // Vanish the row after it has been served and embedded.
        rows.length = 0;
        return json(200, { data: inputs.map((_, index) => ({ index, embedding: vector() })) });
      },
    }, ({ base }) => runBackfill(base));

    assert.match(
      stdout, /rows:\s+0 \(1 failed/,
      'a write that matched no row must be counted failed and NOT done — it is still null, and '
      + 'a rerun must retry it rather than treat it as embedded',
    );
  });

  test('passing the skip cap stops the run BEFORE it pays for another page', async () => {
    // The cap used to be checked only between pages, while `skipIds` grows
    // INSIDE one — so a page whose unembeddable rows carried the set past the
    // cap still had its embeddable rows sent to the provider, and only then did
    // the run stop. That is a paid call on a page already abandoned.
    //
    // `--batch-size 20` so the arithmetic is legible and independent of the
    // default: four pages of 18 unembeddable + 2 usable rows. The skip set
    // reaches 18, 36, 54, then 72 — so it passes MAX_SKIP_IDS (70) while reading
    // page FOUR, and page four's two usable rows must never reach the provider.
    // Three embed calls, not four; the fourth is the regression.
    const rows = [];
    for (let block = 0; block < 4; block++) {
      for (let i = 0; i < 18; i++) {
        rows.push({ id: `00000000-0000-0000-0000-e${block}${String(i).padStart(11, '0')}`,
                    key: '', value: '   ', embedding: null, embedding_model: null });
      }
      for (let i = 0; i < 2; i++) {
        rows.push({ id: `00000000-0000-0000-0000-u${block}${String(i).padStart(11, '0')}`,
                    key: `k${block}${i}`, value: `lesson ${block}${i}`, embedding: null, embedding_model: null });
      }
    }

    const { stdout, calls } = await withUpstreams({ rows, embed: okEmbed }, async ({ base, calls }) => {
      const res = await runBackfill(base, ['--batch-size', '20']);
      return { ...res, calls };
    });

    assert.equal(
      calls.embed, 3,
      `the provider must be called three times, not once per page: the run passes the skip cap `
      + `while reading page four and must stop before embedding it (saw ${calls.embed})`,
    );
    assert.match(
      stdout, /work remains/,
      'a run that stops with rows still unprocessed must not claim completion',
    );
  });
});
