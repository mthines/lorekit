# Embeddings

Semantic search for lore, in three deliberately separate pieces:

| Piece | Where | State |
|-------|-------|-------|
| Schema | `supabase/migrations/00060_memory_embeddings.sql` | Landed, dormant |
| Pipeline | `_shared/embed-on-write.ts` + `scripts/backfill-embeddings.mjs` | Landed, **off by default** |
| Search | `POST /memories/search?mode=semantic\|hybrid` | Not built |

They are separate because they fail differently. The schema is a migration; the
pipeline is a provider dependency with a bill attached; the search is a recall
tuning problem. Bundled, the first is unreviewable and the last is impossible to
abandon. Split, any of them can be stopped without unpicking the others.

**Nothing here runs in CI.** Embedding costs money and depends on a third-party
endpoint, so every run is manual and on demand — the same posture
`packages/evals` takes for live agent runs. There is no scheduled backfill and
no deploy step that embeds anything.

---

## Turning it on

Two variables, and **both** are required. The flag says a human decided to spend
money; the key says they supplied the means. Either alone leaves embedding off —
a key on its own must not silently start billing an account because someone set
a variable for another purpose, and a flag on its own must not make every write
log a failure.

```bash
supabase secrets set \
  LOREKIT_EMBEDDING_ENABLED=true \
  LOREKIT_EMBEDDING_API_KEY=<provider-key> \
  --project-ref pqokxlhvnosogizsjztg
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `LOREKIT_EMBEDDING_ENABLED` | *(off)* | `true` / `1` / `yes` / `on` enables it. Anything else, including absent, is off. |
| `LOREKIT_EMBEDDING_API_KEY` | — | Provider key. **Never committed**; a Supabase secret, exactly like `GITHUB_APP_PRIVATE_KEY`. |
| `LOREKIT_EMBEDDING_MODEL` | `text-embedding-3-small` | Must be able to emit 1536 dimensions — see below. |
| `LOREKIT_EMBEDDING_ENDPOINT` | OpenAI `/v1/embeddings` | Any OpenAI-compatible endpoint. |
| `LOREKIT_EMBEDDING_USD_PER_MTOK` | — | Price per million tokens. **Reporting only** — never used to decide anything. |

### The 1536 constraint

`memories.embedding` is `vector(1536)` and that is a constraint rather than a
preference: pgvector's HNSW index refuses more than **2000 dimensions** on the
`vector` type, so a 3072-wide model could not be ANN-indexed at all without
switching the column to `halfvec` and halving precision.

This does **not** lock you to one provider. A request to the
`text-embedding-3-*` family asks for `dimensions: 1536` explicitly, and those
models honour it through Matryoshka truncation — so a 3072-native model can
serve this column.

The field is sent **only** to that family. `dimensions` arrived with it;
`ada-002` and a number of OpenAI-compatible endpoints reject an unrecognised
field with a 400, so sending it unconditionally would break every call against
exactly the endpoints listed as swappable above. A **provider prefix counts as
the same family** — `openai/text-embedding-3-small` and
`azure/text-embedding-3-large`, the form OpenRouter/LiteLLM/Azure routers use,
are recognised — because those are the same OpenAI models, and excluding them
would break the proxies this rule exists to protect.

Any other model is asked at its native width instead, and the width is still
enforced on the way back: a model that cannot serve 1536 is refused loudly —
`parseEmbeddingResponse` throws on a wrong-width vector, naming the width,
rather than storing it. That is also the answer for a deployment name that hides
the model (an Azure deployment called `embeddings-prod`): no name-based rule can
see the family, so the field is omitted and the response is checked.

---

## What gets embedded

`key`, then a blank line, then `value`, truncated to 8000 characters on a word
boundary.

The key is included and comes first because a LoreKit key is a summary by
convention (`aw-lessons::retry-on-timeout`), so it is unusually
information-dense per character — exactly what belongs at the front of a
truncated input. And the pair **mirrors the `fts` column**, which is generated
over `key || ' ' || value`: the two retrieval paths must see the same document,
or a future hybrid search would be fusing rankings over different text and a
lesson would be findable by keyword but not by meaning, for no reason a user
could discover.

The 8000-character cap exists twice over. A provider bills per token, so an
unbounded body is an unbounded bill — one pasted stack trace could cost more
than the rest of the store. And beyond a few thousand characters a single vector
stops meaning much anyway: it averages the whole document into one point.
Chunking a long lesson into several vectors is the real answer to that, and a
much larger change.

---

## The write path

`embedOnWrite` runs after a successful `POST /memories`. **A memory write is
never slower, and never fails, because of an embedding** — the lesson the agent
asked to save is the thing being paid for; the vector is an optimisation for a
search that may never happen.

Two mechanisms enforce that:

1. The provider call is **backgrounded** via `EdgeRuntime.waitUntil`, so it is
   not on the response path.
2. If `waitUntil` is unavailable, it **skips** rather than falling back to
   awaiting. Awaiting would silently reintroduce provider latency into every
   write on any runtime lacking the API — precisely the failure the design
   avoids. The row stays null and the backfill collects it, which is the same
   outcome as a provider error and needs no extra machinery.

There is **no retry** on the write path: a retry there is only a slower way to
fail, and the backfill retries by construction because it selects on
`embedding is null`.

The causes of "no embeddings appeared" are told apart on the spans rather than
by reading provider logs — but they are on **two** spans, and which one matters:

| Span | Signal | Meaning |
|------|--------|---------|
| the **request** span | `lorekit.embedding.enqueued` | the call was handed to the background runtime |
| the **request** span | `lorekit.embedding.skipped = no_background_runtime` | no `waitUntil` on this runtime; the row stays null for the backfill |
| the **request** span | `lorekit.embedding.skipped = no_embeddable_text` | the memory's key and value are empty or whitespace; no rerun will ever fill it |
| `lorekit.embedding.write` (detached) | an `embedding update:` / `embedding failed:` error | the write or the provider call failed |
| `lorekit.embedding.write` (detached) | `embedding update matched no row` | the vector arrived but no row was written — see [Who may write a vector](#who-may-write-a-vector) |

There is no `no_vector` signal: response validation is strict and throws, so a
provider that answers without a usable vector arrives as an `embedding failed:`
error on the same span rather than as a separate skip reason.

There is deliberately no `disabled` signal either. That is a deployment-wide
constant — the flag and the key — and the **default** state, so recording it
would stamp an attribute on every `POST /memories` on every project to report
something already in the configuration. Check the flag first; the span is for the
causes the flag cannot explain.

### Who may write a vector

On the **edge write path** the vector is written through the
`lorekit_memory_set_embedding` RPC (migration `00062`), never by a direct
`UPDATE` on `memories`. (The backfill still PATCHes the two columns directly: it
runs as service role across every tenant, which is the one credential `rls_update`
already admits, and it has no caller identity to authorise against.) That is not
ceremony — on the request path the direct update was **silently wrong for
org-owned memories**:

- the READ policies were widened for orgs in `00015`
  (`org_id in (select lorekit_member_org_ids(auth.uid()))`);
- `rls_update` from `00001` never was, and still admits only
  `user_id = auth.uid()` or a service-role connection;
- an org-owned memory carries `user_id is null` (`00019`).

So under a Supabase JWT the update matched **zero rows**, and a zero-row update
is not an error in PostgREST. Every org memory went unembedded with no signal
anywhere, waiting for a backfill nobody had a reason to run. The `api_key` and
`service` tiers were unaffected, because both hold a service-role client — which
is exactly why the gap survived: it is invisible on the tiers most likely to be
exercised.

Widening `rls_update` to match `rls_read` would have fixed the embed and opened
a hole: every org **member** could then rewrite any column of any org memory
through PostgREST, with no role check. Org writes are gated on
`lorekit_org_can(…, 'write')` — a **viewer** must not write — and RLS cannot
express that. So the write moved into an RPC that authorises inside itself,
composing the predicates the schema already owns (`lorekit_org_actor`,
`lorekit_org_can`, `lorekit_member_org_ids`) rather than restating `00019`'s
ownership branching in TypeScript where no migration test would ever run it.

The RPC returns whether a row was written, and a `false` becomes the
`embedding update matched no row` error above. **A miss is reported, never
assumed benign** — if a future ownership model escapes those predicates it
surfaces as a span signal rather than as an empty column discovered months later
when a semantic search comes back thin. The row stays null and the backfill
collects it, exactly as on a provider fault.

Behaviour is asserted in `supabase/tests/migrations.test.sql` (section 62,
including that an org viewer is refused and that the old direct update still
does not land); the edge module is held to the RPC by
`packages/mcp-core/src/embed-write-authz.spec.ts`.

### Embedding a row does not touch `updated_at`

`memories_updated_at` (`00001`) is a `BEFORE UPDATE` trigger that stamps
`updated_at = now()`. A vector is a **derived artefact, not an edit**, so
`00062` retargets that trigger at `lorekit_memories_set_updated_at`.

The rule is deliberately narrow: `updated_at` is preserved only when the
embedding columns **actually moved** *and* nothing else changed. Everything else
keeps the behaviour `set_updated_at` always had — including a plain **no-op
re-write**, which matters because `memory_write` upserts, so an agent re-saving
an identical lesson lands on this trigger with every column unchanged. Treating
that as "nothing meaningful changed" would silently stop re-saves from
refreshing recency: a behaviour change reaching well beyond embeddings, in a
migration whose entire claim is that a derived column must not disturb the row.
Asserted by §62b AC-6.

This is enforced at the storage layer rather than at each caller, so the edge
RPC, the backfill's PATCH and any future writer all inherit it. It matters most
for the backfill: `updated_at` is what `POST /memories/search` and
`GET /memories/relevant` order by, what `memory.list` keysets on
(`memories_scope_updated_at_id_idx`), and what `lesson-rank` scores for recency
— so a whole-store run would otherwise restamp every row in `created_at desc`
order and collapse the real ordering into the order the backfill happened to
run in, with the original values unrecoverable.

The shared `set_updated_at` is untouched; the five other tables using it
(`user_limits`, `orgs`, `org_limits`, `plans`, `user_plans`) have no embedding
column and keep the plain behaviour. Asserted in `migrations.test.sql`
section 62b, including that a real edit still bumps and that `orgs` still uses
the shared function.

Everything after the enqueue lands on the **detached** `lorekit.embedding.write`
span, not on the request span. It has to: `traceRequest` ends the request span
and drains its batch in a `finally` that runs before the background callback
resolves, so an outcome recorded on the request span would never be exported —
`enqueued` would be the only observable half. The consequence for an operator is
that a request span showing `enqueued` and nothing else is **not** a failure
signal; the outcome is on the child span, which carries `lorekit.memory_id` and
`lorekit.embedding.model` so it can be found from the memory alone.

> `PATCH /memories/:id` does **not** re-embed. An edited memory keeps its old
> vector until the backfill is next run — a known gap, not an oversight: it
> needs a staleness signal (compare `updated_at` against an embed timestamp)
> that the schema does not carry yet.
>
> The same missing signal has a cost-shaped twin on the other side.
> `memory_write` **upserts**, so an agent re-saving an unchanged lesson reaches
> `embedOnWrite` again and pays for another embedding of identical text. Gating
> on `row.inserted` would stop that — and would also stop re-embedding a lesson
> that genuinely *changed* on the same upsert, trading a correctness regression
> for a cost saving. Both halves want the same fix: a hash of the embedded text
> (or an embed timestamp) so "has this text already been embedded" becomes
> answerable. Until then the write path errs toward paying twice rather than
> serving a stale vector, and the two are tracked together.
>
> **MCP `memory.write` does not embed at all.** Only the REST create path calls
> `embedOnWrite`, so a lesson saved through the MCP tool — which is how most
> agents write — stays `embedding is null` until the backfill runs. Until then
> the backfill is the only thing that embeds MCP-written lore, which is worth
> knowing before reading coverage numbers off a store that is mostly
> agent-written.
>
> This is not the staleness problem above, and it is **not** a mirroring problem
> either: seven files under `supabase/functions/mcp/` already import
> `../_shared/*.ts` directly — `index.ts`, `mcp-handler.ts`, `tools.ts`,
> `auth.ts`, `limits.ts`, `webhook.ts` and `installation-sync.ts` — reaching
> modules such as `otel.ts`, `scope.ts`, `audit.ts` and `lesson-rank.ts`. So
> `embed-on-write.ts` is reachable from there as-is. The self-contained rule that
> forbids cross-package imports is about `packages/`, not about the `_shared/`
> tree beside it. The one place `embed-on-write.ts` reaches into `_shared/api/` —
> the tree `mcp/` does deliberately mirror rather than import, see `mcp/cursor.ts`
> — is a **type-only** `DbClient` import, which is erased at runtime and can be a
> local alias if that boundary should hold for types too. So the remaining work is
> calling `embedOnWrite` from the MCP write tool with its client and actor, which
> is small; it simply has not been done.

---

## The backfill

Covers everything written before embedding was enabled, plus anything whose
on-write attempt failed.

```bash
node scripts/backfill-embeddings.mjs --dry-run     # plan + cost, no calls
node scripts/backfill-embeddings.mjs --limit 500   # bounded first run
node scripts/backfill-embeddings.mjs               # to completion
```

Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (it walks every tenant), plus the
provider variables above. `--dry-run` deliberately needs **neither the flag nor
the key**: what a backfill would cost is exactly the question you ask *before*
enabling it.

| Flag | Default | Meaning |
|------|---------|---------|
| `--dry-run` | off | Plan and cost only. One page, no provider call, no write. |
| `--limit <n>` | none | Stop after n rows. A missing, zero, negative, or non-numeric value is a usage error, not "no limit" — it is the flag that bounds what a run spends. |
| `--batch-size <n>` | 96 | Rows per provider request (hard-capped at 96). A zero, negative, or non-numeric value is a usage error, not the cap. |
| `--scope <s>` | all | Only rows in this exact scope. A missing or flag-shaped value is a usage error, not "every scope". |
| `--sleep-ms <n>` | 0 | Pause between batches, for rate-limit relief. A negative or non-numeric value is a usage error, not "no pause". |

An unrecognised flag, or a flag whose value is missing, flag-shaped, or unreadable as a number, is a usage error — the script never falls back silently on the arguments that decide what a paid run touches. The defaults in this table are what an **omitted** flag means; they are never what a typo means.

That parser is unit-tested — `scripts/backfill-embeddings.test.mjs`, `node --test`, no dependencies — so every row above is an executed assertion rather than a promise. Run it with `node --test scripts/backfill-embeddings.test.mjs` (needs Node >= 22.18, the same floor the script itself asserts).

#### Wiring the parser test into CI (one-time, must be committed by a human)

The GitHub App that opens automated PRs cannot modify `.github/workflows/**` (no
`workflows` permission), so the job below is **not** applied by the PR that added
the test — add it by hand, the same way the smoke sweeper's steps were
(`docs/deployment.md` → "Wiring the sweep into CI"). The test itself works
without it; this is what makes it run on every PR.

It is its own job rather than a step in `check` because that job pins Node 20 for
NX, and this script imports the pure embedding module as TypeScript, which needs
Node's type stripping. It is ungated because it is a checkout plus one
zero-dependency `node --test` — a path filter would cost more to maintain than the
seconds it saves.

Add to `.github/workflows/ci.yml`, before the `summary` job:

```yaml
  backfill-args:
    name: Backfill argument parser
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - name: Checkout repository
        uses: actions/checkout@v7.0.1

      - name: Set up Node.js
        uses: actions/setup-node@v7
        with:
          # >= 22.18 for native TypeScript stripping — the script imports
          # packages/mcp-core/src/embedding.ts directly, with no build step.
          node-version: 22

      - name: Unit-test the backfill argument parser
        run: node --test scripts/backfill-embeddings.test.mjs
```

Then add it to the `summary` gate so a failure is not silently ignored:

```yaml
    needs: [changes, check, plugin, integration, web-test, migration-order, backfill-args]
```

Five properties worth knowing before you run it on a large store:

- **Idempotent and resumable, with no state of its own.** The work queue is a
  query (`embedding is null`), so an interrupted run leaves a valid store and
  the next run picks up what is left. No cursor file to go stale, no way for a
  crash to skip a row.
- **It pages by re-querying, not by offset.** Rows filled by this run drop out
  of the next result on their own. An offset walk over a set the run is mutating
  skips rows silently, and the gap is invisible afterwards.
- **A failed batch is skipped, not fatal**, and those rows stay null for the
  next run. There is no `--strict`: a partially-complete backfill is a normal
  state here, so the script exits 0 and reports the counts. The failure unit
  differs by phase — the provider call is all-or-nothing for its batch, while
  the row writes settle individually, so a row that was written is counted
  `rows`, never `failed`. A run that ends with `failed` above zero prints
  `── backfill incomplete (work remains) ──`, not `── backfill complete ──`:
  those rows are still null and a rerun retries them, so the headline says so.
- **A run can stop with work left, and says so.** A row this run cannot process
  (a rejected batch, a memory with no embeddable text) is excluded from the
  queue for the rest of the run, because the queue is a query and a row left
  null would otherwise be served forever. That exclusion list travels in the
  URL, so it is capped at **70** rows; past the cap the run stops and prints
  `── backfill stopped early (work remains) ──` with a `stopped:` count instead
  of `── backfill complete ──`. The cap is checked wherever the list GROWS, not
  only between pages — so passing it also stops the run **before** it pays a
  provider for a page it has already decided to abandon. The set can still
  overshoot by at most one batch, and 70 is *derived* from that: nginx's default
  request-line limit is 8 KB, a uuid plus its comma is 37 bytes, so the id list
  gets a 6 KB budget = 166 ids, minus the 96-row maximum overshoot = 70. Capping
  at the budget itself would let a heavily-failing run reach ~296 ids ≈ 11 KB and
  start returning 414 instead of stopping cleanly. Fix what the failure lines name, then rerun —
  the next run starts from a clean exclusion list. The three headlines are
  therefore `complete` (nothing retryable left), `incomplete (work remains)`
  (the walk finished, some rows failed), and `stopped early (work remains)`
  (the exclusion-list cap ended the walk with rows still queued). Only
  `unusable:` rows — no embeddable text — are excluded from "work remains",
  because a rerun will never fill them.
- **It never prints the key.** Provider error bodies are truncated; the key only
  ever travels in a header.

---

## Measuring before you commit

The go/no-go for building semantic search is whether the cost and latency are
acceptable on a real store. Run the dry run first:

```bash
LOREKIT_EMBEDDING_USD_PER_MTOK=0.02 node scripts/backfill-embeddings.mjs --dry-run
```

It reports characters, approximate tokens (chars ÷ 4 — the same zero-dependency
heuristic the CLI's SessionStart budget uses; neither needs better than an order
of magnitude), and the estimated dollars for **one page**. Multiply by your
pending count for a whole-store figure.

On a real run the cost line counts a batch only once the provider has accepted it, so a rejected batch is never billed into `chars:` / `est. cost:`.

`usd` reports as `unknown` rather than `0` when no price is configured. A
guessed price is worse than an absent one when the number is about to inform a
decision.

---

## Rolling back

Unset `LOREKIT_EMBEDDING_ENABLED`. New writes stop embedding immediately;
existing vectors are inert because nothing reads the column yet. To clear them:

```sql
update memories set embedding = null, embedding_model = null
where embedding is not null;
```

Both columns in one statement — the 00060 CHECK requires both-or-neither, so a
split update is rejected. The `where` clause is not decoration: without it this
touches every row in the table, and while `00062`'s trigger keeps an
embedding-only change from restamping `updated_at`, there is no reason to
rewrite rows that never carried a vector.

---

## Smoke tests

Two layers, because they catch different things and cost different amounts.

### Offline resilience — `scripts/backfill-embeddings.smoke.test.mjs`

Drives the **real backfill script** as a child process against a fake provider
and a fake PostgREST on localhost. No key, no network, no money, so it is
deterministic and runs anywhere:

```bash
node --test scripts/backfill-embeddings.smoke.test.mjs
```

It exists because the unit specs cover the pure decisions and the argument
parsing, but neither runs the script's **loop** — and the loop is where every
property that matters under failure lives. Each of these is a fixture rather
than something to wait for a provider to do:

| Failure | Required behaviour |
|---------|--------------------|
| Provider 500 on one batch | Skip that batch, finish the run, leave those rows null |
| Provider fails *every* time | Terminate — do not re-serve the same page forever |
| Wrong-width vector | Refuse; write nothing |
| Malformed / non-JSON body | Skipped batch, exit 0, nothing written |
| Response missing one input's vector | Refuse the whole batch, not partial credit |
| Provider reflects the key in an error | The key never reaches stdout or stderr |
| Row with no embeddable text | Skipped, and does not stall the page |
| `--dry-run` | No provider call, no write, and works with no key |

> The key-leak test found a real one. Several providers echo the offending
> credential back in an error body ("invalid api key: sk-…"), and the script
> logs provider errors because a bare status code sends an operator hunting.
> `redactKey` now runs at every point that turns a provider response into a
> message — in the script and in the edge client.

### Live — `scripts/smoke-embeddings.mjs`

Proves the path a fake cannot: a wrong model name, a revoked key, a changed
response shape, a model whose real output width does not match the column, and
grants that only exist in the real database.

```bash
node scripts/smoke-embeddings.mjs          # writes, checks, cleans up
node scripts/smoke-embeddings.mjs --keep   # leave the artefacts for inspection
```

It checks that the provider answers at the declared width (reporting latency),
that a real vector round-trips through the column with its model, and that the
both-or-neither CHECK is live on the real database rather than merely present in
a migration file. That last check requires the refusal to name
`memories_embedding_model_pairing`: it previously accepted *any* thrown error,
so an expired key or a network blip reported the constraint as live having
proved nothing — the one check whose entire job is "do not trust the migration
file" was itself trusting a bare `catch`.

**It writes to a live tenant, so cleanup is the point.** Every artefact is
minted through the same namespace contract the other live suites use — the name
is registered at mint time, carries a timestamp, and matches
`SMOKE_ARTEFACT_PATTERN` (its `embed-` label is part of that closed set), so a
run that crashes before cleanup is still recognisable to
`scripts/smoke-cleanup.mjs`. Deletion is a **hard** delete; the default soft
archive would leave a row behind on every run forever. A leak is reported as a
warning rather than thrown, so it is visible without turning a passing run red.

It refuses to run against a project with embedding disabled: a skipped run that
reports success is worse than no run.

---

## Where the code lives

| File | Role |
|------|------|
| `packages/mcp-core/src/embedding.ts` | **Pure**: what to embed, request shape, response validation, batching, cost. Unit-tested without a key. |
| `packages/mcp-core/src/embedding.spec.ts` | Unit tests over the above — config resolution, input construction, request shape, response validation, batching, and cost. No key required. |
| `supabase/functions/_shared/embedding.ts` | Verbatim mirror (`edge-parity.spec.ts`). |
| `supabase/functions/_shared/embedding-client.ts` | **Impure**: the `fetch`, the key, the timeout. Deno-only, not mirrored. |
| `supabase/functions/_shared/embed-on-write.ts` | The background-and-swallow write path. |
| `supabase/migrations/00062_memory_embedding_write.sql` | `lorekit_memory_set_embedding` — the ONE authorised path for writing a vector. Authorises inside the function so an org-owned row is embeddable by a write-capable member and refused for a viewer. |
| `packages/mcp-core/src/embed-write-authz.spec.ts` | Drift guard: holds the edge module to the RPC and off a direct `UPDATE`. Mutation-verified — restoring the direct update fails three of its cases. |
| `scripts/backfill-embeddings.mjs` | The manual backfill. Imports the pure module rather than re-implementing it. Exports `parseArgs` behind an `invokedDirectly` seam so importing it never starts a run. |
| `scripts/backfill-embeddings.test.mjs` | `node --test` cover for `parseArgs` — the guard on what a paid run touches. CI wiring is a one-time human step, above. |

The pure/impure split is the `github-app-jwt.ts` pattern, and it matters more
here than usual: this is the first code in the repo that spends money per call,
so everything deciding how much text goes over the wire, how many rows go per
request, and whether a response is trustworthy is testable without a key.
