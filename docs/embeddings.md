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

This does **not** lock you to one provider. Every request asks for
`dimensions: 1536` explicitly, and models supporting Matryoshka truncation (the
`-3-*` family and several others) honour it — so a 3072-native model can serve
this column. A model that cannot is refused loudly:
`parseEmbeddingResponse` throws on a wrong-width vector rather than storing it.

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

Three different causes produce "no embeddings appeared", and they are told apart
on the span rather than by reading provider logs:
`lorekit.embedding.enqueued` (queued), `lorekit.embedding.skipped`
(no background runtime), or an `embedding failed:` span error.

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
| `--limit <n>` | none | Stop after n rows. |
| `--batch-size <n>` | 96 | Rows per provider request (hard-capped at 96). |
| `--scope <s>` | all | Only rows in this exact scope. |
| `--sleep-ms <n>` | 0 | Pause between batches, for rate-limit relief. |

Four properties worth knowing before you run it on a large store:

- **Idempotent and resumable, with no state of its own.** The work queue is a
  query (`embedding is null`), so an interrupted run leaves a valid store and
  the next run picks up what is left. No cursor file to go stale, no way for a
  crash to skip a row.
- **It pages by re-querying, not by offset.** Rows filled by this run drop out
  of the next result on their own. An offset walk over a set the run is mutating
  skips rows silently, and the gap is invisible afterwards.
- **A failed batch is skipped, not fatal**, and those rows stay null for the
  next run. There is no `--strict`: a partially-complete backfill is a normal
  state here, so the script exits 0 and reports the counts.
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
| `packages/mcp-core/src/embedding.spec.ts` | 26 tests over the above. |
| `supabase/functions/_shared/embedding.ts` | Verbatim mirror (`edge-parity.spec.ts`). |
| `supabase/functions/_shared/embedding-client.ts` | **Impure**: the `fetch`, the key, the timeout. Deno-only, not mirrored. |
| `supabase/functions/_shared/embed-on-write.ts` | The background-and-swallow write path. |
| `scripts/backfill-embeddings.mjs` | The manual backfill. Imports the pure module rather than re-implementing it. |

The pure/impure split is the `github-app-jwt.ts` pattern, and it matters more
here than usual: this is the first code in the repo that spends money per call,
so everything deciding how much text goes over the wire, how many rows go per
request, and whether a response is trustworthy is testable without a key.
