-- ═════════════════════════════════════════════════════════════════════════
-- memories.embedding — the semantic-search column, landed DORMANT.
--
-- WHY SEPARATELY, AND WHY EMPTY: nothing reads or writes this column in this
-- migration, and that is the entire point. The embedding arc has three
-- independent risks — a schema change, a provider dependency with a real cost
-- and latency, and a ranking-fusion tuning problem — and bundling them makes
-- the first impossible to review and the last impossible to abandon. Landing
-- the schema alone means the write pipeline (which needs an API key, a backfill
-- and a budget) and the search modes (which need recall tuning) can each be
-- decided on their own evidence, and either can be dropped without unpicking a
-- migration.
--
-- After this migration the database is byte-for-byte equivalent in behaviour:
-- every existing row has `embedding is null`, no handler selects the column, no
-- RPC writes it, and `MEMORY_SELECT` does not name it. The only observable
-- change is that `pgvector` is enabled and two nullable columns exist.
--
-- ── The two choices a reviewer should actually check ──────────────────────
--
-- DIMENSION 1536, and it is a constraint rather than a preference. pgvector's
-- HNSW index refuses more than 2000 dimensions on the `vector` type, so a
-- 3072-dimension model (OpenAI `text-embedding-3-large`, Gemini's large
-- embedding) cannot be ANN-indexed here at all without switching the column to
-- `halfvec` and halving precision. 1536 is `text-embedding-3-small`'s native
-- width, sits comfortably under the ceiling, and is the width every mainstream
-- provider can produce — several support Matryoshka truncation to it, so
-- choosing 1536 does NOT lock the pipeline to one vendor. Changing this later
-- is a table rewrite, which is exactly why it is being decided now, in
-- isolation, rather than discovered during the pipeline PR.
--
-- HNSW, NOT IVFFLAT, and the emptiness is the reason. An IVFFlat index
-- partitions the vector space by clustering the rows that exist AT BUILD TIME;
-- built on an empty table it produces meaningless centroids and has to be
-- dropped and rebuilt once data lands — which is a second migration and an
-- outage-shaped operation on a large table. HNSW builds a graph incrementally
-- as rows arrive, so an index created on zero rows is correct and stays correct.
-- Given this column is deliberately empty today, IVFFlat would be the wrong
-- structure by construction.
--
-- COSINE (`vector_cosine_ops`) because text embeddings from every provider
-- worth using are L2-normalised, where cosine distance and inner product rank
-- identically and cosine is the one that stays correct if a future provider is
-- not normalised.
--
-- PARTIAL (`where embedding is not null`) so the index describes only rows that
-- have one. Today that is none, so the index costs nothing; during the backfill
-- it grows with coverage instead of being sized for the whole table up front.
-- ═════════════════════════════════════════════════════════════════════════

-- Supabase provisions `vector` in the `extensions` schema on hosted projects
-- and `if not exists` makes this a no-op there; locally it is what installs it.
-- Same shape as `pg_trgm` in 00012 — no schema qualification, so it resolves
-- wherever the project already puts extensions.
create extension if not exists vector;

-- ── the column ──────────────────────────────────────────────────────────────
-- Nullable with no default: null means "not embedded yet", which is the state
-- every existing row is in and the state the backfill queries for. A default
-- would make "never embedded" indistinguishable from "embedded as zeroes".
alter table memories add column if not exists embedding vector(1536);

-- WHICH MODEL produced the vector. Not decoration: embeddings from two models
-- are not comparable, so a silent provider swap would leave the table holding
-- two incompatible vector spaces and a similarity search would return confident
-- nonsense across the boundary. Recording it is what makes a re-embed
-- targetable (`where embedding_model <> $current`) instead of a full rebuild,
-- and it is far cheaper to add now, on an empty column, than after a backfill.
alter table memories add column if not exists embedding_model text;

-- Length backstop only — the vocabulary is the pipeline's to police, exactly as
-- 00056 argued for `kind`/`host`. This bounds storage and cardinality without
-- turning "support another provider" into a migration.
alter table memories drop constraint if exists memories_embedding_model_len;
alter table memories add constraint memories_embedding_model_len
  check (embedding_model is null or (char_length(embedding_model) between 1 and 128));

-- A vector without a model is unattributable, and a model without a vector is a
-- lie about what the row holds. Both-or-neither, enforced here rather than
-- trusted to the writer, because the failure it prevents is silent.
alter table memories drop constraint if exists memories_embedding_model_pairing;
alter table memories add constraint memories_embedding_model_pairing
  check ((embedding is null) = (embedding_model is null));

-- ── the ANN index ───────────────────────────────────────────────────────────
-- `m` and `ef_construction` are pgvector's defaults, stated explicitly so the
-- build parameters are visible in the schema rather than inherited from
-- whatever version happens to be installed. Recall tuning belongs with the
-- search modes, where it can be measured.
create index if not exists memories_embedding_hnsw_idx
  on memories using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64)
  where embedding is not null;

-- Coverage lookup for the backfill: "which rows still need embedding", newest
-- first. Without it a resumable backfill sequentially scans the whole table on
-- every batch, which is the shape that makes a backfill quadratic.
create index if not exists memories_embedding_pending_idx
  on memories (created_at desc)
  where embedding is null;
