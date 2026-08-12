/**
 * Embeddings — the pure half.
 *
 * Everything here is a total function over plain data: what text a memory
 * embeds as, how a provider request is shaped, how its response is validated,
 * how a batch is sized, what a run costs. The impure half — the actual `fetch`,
 * the API key, the clock — lives in `supabase/functions/_shared/embedding-client.ts`
 * and in `scripts/backfill-embeddings.mjs`, which are the two places that can
 * reach a network.
 *
 * The split is the `github-app-jwt.ts` pattern, and it matters more here than
 * usual: this is the first code in the repo that spends MONEY per call, so the
 * parts that decide how much text goes over the wire, how many rows go per
 * request, and whether a response is trustworthy all need to be unit-testable
 * without a key.
 *
 * Import-free so it can be mirrored verbatim into
 * `supabase/functions/_shared/embedding.ts` (`edge-parity.spec.ts` MIRRORS).
 *
 * NOTHING here is wired into a CI gate. Embedding runs cost money and depend on
 * a third-party endpoint, so they are manual and on demand — the same posture
 * `packages/evals` takes for live agent runs.
 */

/**
 * The vector width the `memories.embedding` column is declared at (00060).
 *
 * Not a preference: pgvector's HNSW index refuses more than 2000 dimensions on
 * the `vector` type, so a 3072-wide model could not be ANN-indexed at all.
 * Changing this is a table rewrite, so a provider that cannot produce 1536 is a
 * provider this schema cannot use — see `supportsDimensions`.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Default model. Native 1536, and the cheapest of the mainstream options. */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Default endpoint. OpenAI-compatible, which most providers now expose. */
export const DEFAULT_EMBEDDING_ENDPOINT = 'https://api.openai.com/v1/embeddings';

/**
 * Cap on the characters embedded per memory.
 *
 * Two reasons, and the second is the one that bites. A provider bills per
 * token, so an unbounded body is an unbounded bill — one pasted stack trace in
 * a lesson could cost more than the rest of the store combined. And beyond a
 * few thousand characters a single vector stops meaning anything anyway: it
 * averages the whole document into one point, so the tail contributes noise
 * rather than signal. Chunking a long lesson into several vectors is a real
 * answer to that, and a much larger change than this one.
 *
 * ~8000 characters is roughly 2000 tokens, comfortably inside every provider's
 * per-input limit while covering the overwhelming majority of lessons whole.
 */
export const MAX_EMBED_CHARS = 8000;

/** Cap on inputs per provider request. Bounds one request's blast radius. */
export const MAX_BATCH_ITEMS = 96;

/** Cap on characters per provider request, across all its inputs. */
export const MAX_BATCH_CHARS = 96_000;

/** Rough chars-per-token. The same zero-dependency heuristic the CLI's
 *  SessionStart budget uses — a real tokenizer is a dependency neither of them
 *  will take, and both only need the right order of magnitude. */
const CHARS_PER_TOKEN = 4;

export interface EmbeddingConfig {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  endpoint: string;
  /** For cost reporting only — never used to decide anything. */
  usdPerMillionTokens: number | null;
}

/**
 * Resolve the embedding configuration from an environment bag.
 *
 * DISABLED BY DEFAULT, and both halves must be present to enable it: the flag
 * says a human decided to spend money, the key says they supplied the means. A
 * key alone must not silently start billing an account because someone set a
 * variable for a different purpose; a flag alone must not make every write log
 * a failure.
 *
 * Total: a missing, blank or non-string value degrades to the default rather
 * than throwing, because this is read on the write path.
 */
export function resolveEmbeddingConfig(env: Record<string, string | undefined> = {}): EmbeddingConfig {
  const apiKey = str(env['LOREKIT_EMBEDDING_API_KEY']);
  const flag = str(env['LOREKIT_EMBEDDING_ENABLED']);
  const enabled = Boolean(apiKey) && ['true', '1', 'yes', 'on'].includes((flag ?? '').toLowerCase());
  return {
    enabled,
    apiKey,
    model: str(env['LOREKIT_EMBEDDING_MODEL']) ?? DEFAULT_EMBEDDING_MODEL,
    endpoint: str(env['LOREKIT_EMBEDDING_ENDPOINT']) ?? DEFAULT_EMBEDDING_ENDPOINT,
    usdPerMillionTokens: num(env['LOREKIT_EMBEDDING_USD_PER_MTOK']),
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The text a memory embeds as: `key` then `value`, truncated.
 *
 * MIRRORS THE `fts` COLUMN, which is generated over `key || ' ' || value`
 * (00001). The two retrieval paths must see the same text or a hybrid search
 * would be fusing rankings over different documents — a lesson findable by
 * keyword but not by meaning, for no reason a user could ever discover.
 *
 * The key is included and comes first because a LoreKit key is a summary by
 * convention (`aw-lessons::retry-on-timeout`), so it is unusually
 * information-dense per character — exactly what you want at the front of a
 * truncated input.
 *
 * Truncation is on a WORD boundary where one is available, so the tail of the
 * input is not half a token of noise.
 */
export function embeddingInput(entry: { key?: unknown; value?: unknown }, max = MAX_EMBED_CHARS): string {
  const key = String(entry?.key ?? '').trim();
  const value = String(entry?.value ?? '').trim();
  const joined = `${key}\n\n${value}`.trim();
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Is this text worth spending a call on? An empty memory embeds to nothing
 *  meaningful, and a provider will happily bill for the attempt. */
export function isEmbeddable(text: unknown): boolean {
  return String(text ?? '').trim().length > 0;
}

/**
 * Does this model's API accept the `dimensions` request parameter?
 *
 * `dimensions` arrived with the `text-embedding-3-*` family. `ada-002` predates
 * it and a number of OpenAI-COMPATIBLE endpoints reject an unrecognised field
 * outright, so sending it unconditionally 400s EVERY call against exactly the
 * provider swap this schema advertises as supported. Gate it on the family that
 * documents the parameter and let every other provider answer at its native
 * width.
 *
 * Omitting it is safe because the width is still checked: a provider whose
 * native width is not this column's is refused loudly by
 * `parseEmbeddingResponse`, with the width in the message — a failure that
 * names the real constraint, rather than a 400 that names a field.
 *
 * A model-family test rather than a sixth `LOREKIT_EMBEDDING_*` variable: a
 * provider whose native width already fits needs no configuration to work, and
 * one whose width does not fit cannot be made to work by a flag. Distinct from
 * `supportsDimensions`, which answers whether a NATIVE width fits at all.
 */
export function acceptsDimensionsParam(model: unknown): boolean {
  return /^text-embedding-3-/.test(String(model ?? '').trim());
}

/** The OpenAI-compatible request body. One shape, both callers. */
export function buildEmbeddingRequest(inputs: readonly string[], config: Pick<EmbeddingConfig, 'model'>) {
  return {
    model: config.model,
    input: [...inputs],
    // Ask the provider to return exactly the width the column is declared at.
    // Models supporting Matryoshka truncation (the `-3-*` family and several
    // others) honour this, which is what lets a 3072-native model be used
    // against a 1536-wide column instead of being unusable. Sent ONLY to the
    // family that documents the parameter — see `acceptsDimensionsParam`.
    ...(acceptsDimensionsParam(config.model) ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
    encoding_format: 'float',
  };
}

export class EmbeddingError extends Error {}

/**
 * Validate and extract vectors from a provider response.
 *
 * STRICT ON PURPOSE, unlike most parsing in this repo. Everywhere else a
 * malformed value degrades to a sensible default; here a wrong-width or
 * non-finite vector must THROW, because the alternative is writing a corrupt
 * embedding that the database will accept (the column only checks width) and
 * that then silently poisons every similarity search against it. A failed embed
 * leaves the column null and the backfill retries it; a bad embed is invisible.
 *
 * Order is asserted too: the response's `index` field is the only thing tying a
 * vector back to its input, and a batch whose order is assumed rather than
 * checked is how every row in a batch ends up with its neighbour's meaning.
 */
export function parseEmbeddingResponse(json: unknown, expectedCount: number): number[][] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new EmbeddingError('embedding response has no data array');
  if (data.length !== expectedCount) {
    throw new EmbeddingError(`embedding response returned ${data.length} vectors, expected ${expectedCount}`);
  }
  const out: number[][] = new Array(expectedCount);
  for (const row of data) {
    const idx = (row as { index?: unknown })?.index;
    const vec = (row as { embedding?: unknown })?.embedding;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= expectedCount) {
      throw new EmbeddingError(`embedding response carried an out-of-range index: ${String(idx)}`);
    }
    if (!Array.isArray(vec)) throw new EmbeddingError(`embedding ${idx} is not an array`);
    if (vec.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError(
        `embedding ${idx} has ${vec.length} dimensions, expected ${EMBEDDING_DIMENSIONS} — `
        + 'the model cannot produce this column\'s width',
      );
    }
    for (const n of vec) {
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new EmbeddingError(`embedding ${idx} contains a non-finite value`);
      }
    }
    if (out[idx]) throw new EmbeddingError(`embedding response repeated index ${idx}`);
    out[idx] = vec as number[];
  }
  return out;
}

/**
 * A pgvector literal. Postgres accepts `[1,2,3]` as text for a `vector`.
 *
 * Built here rather than by JSON.stringify so the numeric formatting is ours:
 * `JSON.stringify` renders a non-finite as `null`, which Postgres would reject
 * with an opaque parse error far from the cause. `parseEmbeddingResponse`
 * already refuses those, so this is a second line — cheap, and the failure it
 * prevents is a confusing one.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const n of vector) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new EmbeddingError('refusing to build a vector literal containing a non-finite value');
    }
  }
  return `[${vector.join(',')}]`;
}

/**
 * Split inputs into provider-sized batches, bounded by BOTH count and total
 * characters.
 *
 * Count alone is not enough: 96 long lessons can exceed a provider's per-request
 * token limit even though every individual input is under the per-input one, and
 * that failure arrives as a 400 on the whole batch — so a run that had been
 * working degrades into repeated total failures the moment the store grows a few
 * large lessons. A single input over the char budget still gets its own batch
 * rather than being dropped; it is already truncated by `embeddingInput`.
 */
export function batchInputs<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  { maxItems = MAX_BATCH_ITEMS, maxChars = MAX_BATCH_CHARS } = {},
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const len = textOf(item).length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export interface CostEstimate {
  chars: number;
  approxTokens: number;
  usd: number | null;
}

/**
 * What a run costs, approximately.
 *
 * Reported, never enforced — a budget check that silently skips rows would make
 * coverage depend on an invisible threshold. The plan makes this measurement
 * the go/no-go for enabling semantic search, so its job is to be READABLE, and
 * `usd` is null rather than 0 when no price is configured: a guessed price is
 * worse than an absent one when the number is about to inform a decision.
 */
export function estimateCost(texts: readonly string[], usdPerMillionTokens: number | null): CostEstimate {
  const chars = (Array.isArray(texts) ? texts : []).reduce((n, t) => n + String(t ?? '').length, 0);
  return estimateCostFromChars(chars, usdPerMillionTokens);
}

/**
 * The same estimate from a character COUNT.
 *
 * A caller that streams through the corpus — the backfill does, batch by batch —
 * has no reason to retain every embedded string just to total their lengths at
 * the end; on a large store that is the run's only unbounded allocation. It gets
 * the counter, and `CHARS_PER_TOKEN` stays in one place instead of being copied
 * into the script.
 */
export function estimateCostFromChars(chars: number, usdPerMillionTokens: number | null): CostEstimate {
  const total = typeof chars === 'number' && Number.isFinite(chars) && chars > 0 ? Math.floor(chars) : 0;
  const approxTokens = Math.ceil(total / CHARS_PER_TOKEN);
  const usd = typeof usdPerMillionTokens === 'number' && Number.isFinite(usdPerMillionTokens)
    ? (approxTokens / 1_000_000) * usdPerMillionTokens
    : null;
  return { chars: total, approxTokens, usd };
}

/** Does a model's native width fit this column? Advisory — a provider that
 *  honours the `dimensions` request parameter can still be used above it. */
export function supportsDimensions(nativeDimensions: number): boolean {
  return nativeDimensions === EMBEDDING_DIMENSIONS;
}
