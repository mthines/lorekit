// Embeddings — the impure half: the API key, the network, the clock.
//
// The decisions (what text to embed, how to shape a request, whether a response
// is trustworthy, how to batch, what it costs) all live in the pure
// `_shared/embedding.ts`, which is unit-tested in `packages/mcp-core`. This file
// is deliberately thin, and everything in it is the part a test cannot cover
// without a key: it is the `github-app-client.ts` split.
//
// NOTHING here runs in CI. Embedding costs money and depends on a third-party
// endpoint, so runs are manual and on demand.
import {
  buildEmbeddingRequest,
  parseEmbeddingResponse,
  redactKey,
  EmbeddingError,
  type EmbeddingConfig,
} from './embedding.ts';

/**
 * Hard ceiling on a provider call.
 *
 * The write path backgrounds its embed, so this bound is not protecting a
 * user's latency — it is protecting the isolate from being held open by a
 * provider that has stopped answering, which on a per-invocation billing model
 * is a cost with no result to show for it.
 */
const EMBED_TIMEOUT_MS = 20_000;

/**
 * Embed one or more inputs. Throws on any failure — the CALLER decides what a
 * failure means.
 *
 * That split matters: on the write path a failure must be swallowed (the memory
 * is saved, the embedding is simply absent and the backfill will catch it),
 * while in the backfill a failure must be surfaced and retried. A function that
 * decided for both would be wrong for one of them.
 */
export async function embedTexts(inputs: readonly string[], config: EmbeddingConfig): Promise<number[][]> {
  if (!config.apiKey) throw new EmbeddingError('no embedding API key configured');
  if (inputs.length === 0) return [];

  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(buildEmbeddingRequest(inputs, config)),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!res.ok) {
    // The body can carry the provider's own reason (quota, bad model, revoked
    // key) and is far more useful than the status alone. Bounded, because it is
    // about to be logged, and NEVER the key — which is only ever in a header.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      detail = '';
    }
    // Redacted: several providers reflect the offending credential in the error
    // body, which would move the key out of a header and into a log.
    const safe = redactKey(detail, config.apiKey);
    throw new EmbeddingError(`embedding request failed with HTTP ${res.status}${safe ? `: ${safe}` : ''}`);
  }

  return parseEmbeddingResponse(await res.json(), inputs.length);
}
