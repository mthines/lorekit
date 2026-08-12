import { describe, it, expect } from 'vitest';
import {
  resolveEmbeddingConfig, embeddingInput, isEmbeddable, buildEmbeddingRequest,
  parseEmbeddingResponse, toVectorLiteral, batchInputs, estimateCost, estimateCostFromChars, supportsDimensions,
  acceptsDimensionsParam,
  EmbeddingError, EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_MODEL, MAX_EMBED_CHARS,
} from './embedding.js';

const vec = (n = EMBEDDING_DIMENSIONS, fill = 0.01) => Array.from({ length: n }, () => fill);
const response = (vectors: number[][]) => ({ data: vectors.map((embedding, index) => ({ index, embedding })) });

describe('resolveEmbeddingConfig', () => {
  it('is disabled unless BOTH the flag and the key are present', () => {
    // The flag says a human decided to spend money; the key says they supplied
    // the means. Either alone must not start billing an account.
    expect(resolveEmbeddingConfig({}).enabled).toBe(false);
    expect(resolveEmbeddingConfig({ LOREKIT_EMBEDDING_API_KEY: 'sk-x' }).enabled).toBe(false);
    expect(resolveEmbeddingConfig({ LOREKIT_EMBEDDING_ENABLED: 'true' }).enabled).toBe(false);
    expect(resolveEmbeddingConfig({ LOREKIT_EMBEDDING_ENABLED: 'true', LOREKIT_EMBEDDING_API_KEY: 'sk-x' }).enabled).toBe(true);
  });

  it('accepts the usual spellings of on, and nothing else', () => {
    const on = (v: string) => resolveEmbeddingConfig({ LOREKIT_EMBEDDING_ENABLED: v, LOREKIT_EMBEDDING_API_KEY: 'k' }).enabled;
    for (const v of ['true', 'TRUE', '1', 'yes', 'on']) expect(on(v)).toBe(true);
    for (const v of ['false', '0', 'no', 'off', 'maybe', '']) expect(on(v)).toBe(false);
  });

  it('defaults the model and endpoint, and degrades a blank value', () => {
    const c = resolveEmbeddingConfig({ LOREKIT_EMBEDDING_MODEL: '   ' });
    expect(c.model).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(c.endpoint).toMatch(/^https:\/\//);
    expect(c.usdPerMillionTokens).toBeNull();
  });

  it('reads a configured price, and rejects an unusable one', () => {
    expect(resolveEmbeddingConfig({ LOREKIT_EMBEDDING_USD_PER_MTOK: '0.02' }).usdPerMillionTokens).toBe(0.02);
    expect(resolveEmbeddingConfig({ LOREKIT_EMBEDDING_USD_PER_MTOK: 'cheap' }).usdPerMillionTokens).toBeNull();
    expect(resolveEmbeddingConfig({ LOREKIT_EMBEDDING_USD_PER_MTOK: '-1' }).usdPerMillionTokens).toBeNull();
  });
});

describe('embeddingInput', () => {
  it('embeds key then value, mirroring the fts column', () => {
    // The two retrieval paths must see the same document or a hybrid search
    // fuses rankings over different text.
    expect(embeddingInput({ key: 'retry-on-timeout', value: 'Wrap the call.' }))
      .toBe('retry-on-timeout\n\nWrap the call.');
  });

  it('truncates on a word boundary and never exceeds the cap', () => {
    const out = embeddingInput({ key: 'k', value: 'word '.repeat(5000) });
    expect(out.length).toBeLessThanOrEqual(MAX_EMBED_CHARS);
    expect(out.endsWith(' ')).toBe(false);
    expect(out).not.toMatch(/wor$/);
  });

  it('falls back to a hard cut when there is no word boundary to use', () => {
    const out = embeddingInput({ key: 'k', value: 'x'.repeat(20000) });
    expect(out.length).toBe(MAX_EMBED_CHARS);
  });

  it('is total over junk', () => {
    expect(embeddingInput({})).toBe('');
    expect(embeddingInput({ key: null, value: undefined })).toBe('');
    expect(embeddingInput(null as never)).toBe('');
  });

  it('isEmbeddable refuses to spend a call on nothing', () => {
    expect(isEmbeddable('')).toBe(false);
    expect(isEmbeddable('   \n ')).toBe(false);
    expect(isEmbeddable(null)).toBe(false);
    expect(isEmbeddable('a')).toBe(true);
  });
});

describe('buildEmbeddingRequest', () => {
  it('asks for the column width explicitly on the family that accepts it', () => {
    // Matryoshka truncation is what lets a 3072-native model serve a 1536-wide
    // column instead of being unusable.
    const body = buildEmbeddingRequest(['a', 'b'], { model: 'text-embedding-3-large' });
    expect(body).toEqual({
      model: 'text-embedding-3-large', input: ['a', 'b'], dimensions: EMBEDDING_DIMENSIONS, encoding_format: 'float',
    });
  });

  it('omits dimensions for a model whose API would reject the field', () => {
    // ada-002 and several OpenAI-compatible endpoints 400 on an unrecognised
    // field, which would break every call against the provider swap the docs
    // advertise. The width is still enforced — on the RESPONSE.
    for (const model of ['text-embedding-ada-002', 'bge-m3', 'm']) {
      const body = buildEmbeddingRequest(['a'], { model });
      expect(body).toEqual({ model, input: ['a'], encoding_format: 'float' });
      expect('dimensions' in body).toBe(false);
    }
  });

  it('copies the inputs rather than aliasing the caller\'s array', () => {
    const inputs = ['a'];
    const body = buildEmbeddingRequest(inputs, { model: 'm' });
    inputs.push('b');
    expect(body.input).toEqual(['a']);
  });
});

describe('acceptsDimensionsParam', () => {
  it('is true only for the text-embedding-3 family, and is total over junk', () => {
    expect(acceptsDimensionsParam('text-embedding-3-small')).toBe(true);
    expect(acceptsDimensionsParam('  text-embedding-3-large  ')).toBe(true);
    expect(acceptsDimensionsParam('text-embedding-ada-002')).toBe(false);
    expect(acceptsDimensionsParam('bge-m3')).toBe(false);
    expect(acceptsDimensionsParam('')).toBe(false);
    expect(acceptsDimensionsParam(null)).toBe(false);
    expect(acceptsDimensionsParam(undefined)).toBe(false);
  });

  it('sees the family through a compatible proxy\'s provider prefix', () => {
    // OpenRouter / LiteLLM / Azure routers address the SAME OpenAI models under
    // a namespaced id. Excluding them would ask a 3072-native `-3-large` at its
    // native width and then hard-reject the response — every call failing,
    // which is worse than the 400 this gate was written to avoid.
    expect(acceptsDimensionsParam('openai/text-embedding-3-small')).toBe(true);
    expect(acceptsDimensionsParam('azure/text-embedding-3-large')).toBe(true);
    expect(acceptsDimensionsParam('azure/openai/text-embedding-3-small')).toBe(true);
    expect(acceptsDimensionsParam('OpenAI/Text-Embedding-3-Small')).toBe(true);
    // A prefix is a prefix — the family still has to be the model itself.
    expect(acceptsDimensionsParam('openai/text-embedding-ada-002')).toBe(false);
    expect(acceptsDimensionsParam('cohere/embed-v4')).toBe(false);
  });

  it('answers conservatively for a deployment name that hides the family', () => {
    // No name-based test can reach an Azure deployment called `embeddings-prod`.
    // The safe answer is to omit the field: the response width is still checked.
    expect(acceptsDimensionsParam('embeddings-prod')).toBe(false);
  });

  it('answers a different question from supportsDimensions', () => {
    // One is about the REQUEST field, the other about a native width fitting
    // the column. A 3072-native -3-* model accepts the param and does not fit
    // natively; that combination is the whole reason the param is sent.
    expect(acceptsDimensionsParam(DEFAULT_EMBEDDING_MODEL)).toBe(true);
    expect(supportsDimensions(3072)).toBe(false);
  });
});

describe('parseEmbeddingResponse', () => {
  it('returns vectors in INPUT order, not response order', () => {
    // `index` is the only thing tying a vector back to its input. A batch whose
    // order is assumed rather than checked is how every row gets its
    // neighbour's meaning.
    const a = vec(EMBEDDING_DIMENSIONS, 0.1);
    const b = vec(EMBEDDING_DIMENSIONS, 0.2);
    const shuffled = { data: [{ index: 1, embedding: b }, { index: 0, embedding: a }] };
    const out = parseEmbeddingResponse(shuffled, 2);
    expect(out[0][0]).toBe(0.1);
    expect(out[1][0]).toBe(0.2);
  });

  it('THROWS on a wrong-width vector rather than degrading', () => {
    // The column only checks width at insert time; a plausible-but-wrong vector
    // would be accepted and would silently poison every search against it. A
    // failed embed leaves null and gets retried; a bad embed is invisible.
    expect(() => parseEmbeddingResponse(response([vec(768)]), 1)).toThrow(EmbeddingError);
    expect(() => parseEmbeddingResponse(response([vec(768)]), 1)).toThrow(/768 dimensions/);
  });

  it('throws on a non-finite value', () => {
    const bad = vec();
    bad[5] = Number.NaN;
    expect(() => parseEmbeddingResponse(response([bad]), 1)).toThrow(/non-finite/);
  });

  it('throws on a count mismatch, a missing array, a bad index, or a repeat', () => {
    expect(() => parseEmbeddingResponse(response([vec()]), 2)).toThrow(/expected 2/);
    expect(() => parseEmbeddingResponse({}, 1)).toThrow(/no data array/);
    expect(() => parseEmbeddingResponse(null, 1)).toThrow(/no data array/);
    expect(() => parseEmbeddingResponse({ data: [{ index: 7, embedding: vec() }] }, 1)).toThrow(/out-of-range/);
    expect(() => parseEmbeddingResponse({ data: [{ index: 'a', embedding: vec() }] }, 1)).toThrow(/out-of-range/);
    expect(() => parseEmbeddingResponse({
      data: [{ index: 0, embedding: vec() }, { index: 0, embedding: vec() }],
    }, 2)).toThrow(/repeated index/);
    expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: 'nope' }] }, 1)).toThrow(/not an array/);
  });

  it('accepts a well-formed response', () => {
    const out = parseEmbeddingResponse(response([vec(), vec()]), 2);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});

describe('toVectorLiteral', () => {
  it('renders the pgvector text form', () => {
    expect(toVectorLiteral([1, 2.5, -0.25])).toBe('[1,2.5,-0.25]');
  });

  it('refuses a non-finite value rather than letting Postgres fail far from the cause', () => {
    // JSON.stringify would render these as `null` and Postgres would reject the
    // literal with an opaque parse error.
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(EmbeddingError);
    expect(() => toVectorLiteral([Number.POSITIVE_INFINITY])).toThrow(EmbeddingError);
  });
});

describe('batchInputs', () => {
  const text = (s: string) => s;

  it('splits on the item cap', () => {
    const items = Array.from({ length: 200 }, () => 'x');
    const batches = batchInputs(items, text, { maxItems: 96, maxChars: 1e9 });
    expect(batches.map((b) => b.length)).toEqual([96, 96, 8]);
  });

  it('splits on the CHARACTER cap too, which the item cap cannot catch', () => {
    // 96 long lessons can exceed a provider's per-request token limit even
    // though each individual input is under the per-input one — and that
    // arrives as a 400 on the whole batch.
    const items = Array.from({ length: 10 }, () => 'x'.repeat(1000));
    const batches = batchInputs(items, text, { maxItems: 96, maxChars: 2500 });
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
  });

  it('gives an over-budget single input its own batch rather than dropping it', () => {
    const batches = batchInputs(['x'.repeat(5000), 'y'], text, { maxItems: 96, maxChars: 100 });
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(1);
  });

  it('is total over an empty or non-array input', () => {
    expect(batchInputs([], text)).toEqual([]);
    expect(batchInputs(null as never, text)).toEqual([]);
  });
});

describe('estimateCost', () => {
  it('reports chars, approximate tokens and usd', () => {
    const est = estimateCost(['x'.repeat(4000)], 0.02);
    expect(est.chars).toBe(4000);
    expect(est.approxTokens).toBe(1000);
    expect(est.usd).toBeCloseTo(0.00002, 10);
  });

  it('reports usd as NULL when no price is configured, never 0', () => {
    // This number is about to inform a go/no-go decision; a guessed price is
    // worse than an absent one.
    expect(estimateCost(['abcd'], null).usd).toBeNull();
  });

  it('is total over junk', () => {
    expect(estimateCost([], null)).toEqual({ chars: 0, approxTokens: 0, usd: null });
    expect(estimateCost(null as never, null).chars).toBe(0);
  });
});

// Reached directly, not only through `estimateCost`: this is the entry point the
// backfill's cost line runs on (it streams a counter rather than retaining the
// texts), so its own guards need their own coverage.
describe('estimateCostFromChars', () => {
  it('reports chars, approximate tokens and usd from a count', () => {
    const est = estimateCostFromChars(4000, 0.02);
    expect(est.chars).toBe(4000);
    expect(est.approxTokens).toBe(1000);
    expect(est.usd).toBeCloseTo(0.00002, 10);
  });

  it('agrees with estimateCost over the same corpus', () => {
    const texts = ['a'.repeat(1234), 'b'.repeat(77)];
    const chars = texts.reduce((n, t) => n + t.length, 0);
    expect(estimateCostFromChars(chars, 0.02)).toEqual(estimateCost(texts, 0.02));
  });

  it('reports usd as NULL when no price is configured, never 0', () => {
    expect(estimateCostFromChars(4000, null).usd).toBeNull();
    expect(estimateCostFromChars(4000, Number.NaN).usd).toBeNull();
    expect(estimateCostFromChars(4000, Number.POSITIVE_INFINITY).usd).toBeNull();
  });

  it('floors a non-integer count rather than reporting a fractional char', () => {
    expect(estimateCostFromChars(4000.9, null).chars).toBe(4000);
  });

  it('clamps a non-positive or non-finite count to zero', () => {
    for (const junk of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '4000']) {
      expect(estimateCostFromChars(junk as never, 0.02)).toEqual({ chars: 0, approxTokens: 0, usd: 0 });
    }
  });
});

describe('supportsDimensions', () => {
  it('is advisory about the column width', () => {
    expect(supportsDimensions(1536)).toBe(true);
    expect(supportsDimensions(3072)).toBe(false);
  });
});
