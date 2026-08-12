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
| `lorekit.embedding.write` (detached) | `lorekit.embedding.skipped = no_vector` | the provider answered, with no vector for this input |
| `lorekit.embedding.write` (detached) | an `embedding update:` / `embedding failed:` error | the write or the provider call failed |

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
  `rows`, never `failed`.
- **A run can stop with work left, and says so.** A row this run cannot process
  (a rejected batch, a memory with no embeddable text) is excluded from the
  queue for the rest of the run, because the queue is a query and a row left
  null would otherwise be served forever. That exclusion list travels in the
  URL, so it is capped at 200 rows; past the cap the run stops and prints
  `── backfill stopped early (work remains) ──` with a `stopped:` count instead
  of `── backfill complete ──`. Fix what the failure lines name, then rerun —
  the next run starts from a clean exclusion list.
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
update memories set embedding = null, embedding_model = null;
```

Both columns in one statement — the 00060 CHECK requires both-or-neither, so a
split update is rejected.

---

## Where the code lives

| File | Role |
|------|------|
| `packages/mcp-core/src/embedding.ts` | **Pure**: what to embed, request shape, response validation, batching, cost. Unit-tested without a key. |
| `packages/mcp-core/src/embedding.spec.ts` | Unit tests over the above — config resolution, input construction, request shape, response validation, batching, and cost. No key required. |
| `supabase/functions/_shared/embedding.ts` | Verbatim mirror (`edge-parity.spec.ts`). |
| `supabase/functions/_shared/embedding-client.ts` | **Impure**: the `fetch`, the key, the timeout. Deno-only, not mirrored. |
| `supabase/functions/_shared/embed-on-write.ts` | The background-and-swallow write path. |
| `scripts/backfill-embeddings.mjs` | The manual backfill. Imports the pure module rather than re-implementing it. |

The pure/impure split is the `github-app-jwt.ts` pattern, and it matters more
here than usual: this is the first code in the repo that spends money per call,
so everything deciding how much text goes over the wire, how many rows go per
request, and whether a response is trustworthy is testable without a key.
