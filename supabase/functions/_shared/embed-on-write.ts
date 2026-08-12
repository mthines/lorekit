// Best-effort embedding on the write path.
//
// THE CONTRACT, AND IT IS THE WHOLE MODULE: a memory write must never be
// slower, and must never fail, because of an embedding. A lesson the agent
// asked to save is the thing being paid for; the vector is an optimisation for
// a search that may never happen.
//
// Two mechanisms enforce that, and the second is the one worth reading twice.
//
//   1. It is BACKGROUNDED via `EdgeRuntime.waitUntil`, so the provider round
//      trip is not on the response path at all.
//   2. If `waitUntil` is unavailable, it does NOT fall back to awaiting — it
//      SKIPS. Awaiting would silently reintroduce provider latency into every
//      write on whatever runtime lacked the API, which is exactly the failure
//      this module exists to prevent. The row stays null and the backfill
//      picks it up, which is the same outcome as a provider error and needs no
//      extra machinery.
//
// Every failure is swallowed after being recorded on the span. There is no
// retry here: a retry on the write path is just a slower way to fail, and the
// backfill already retries by construction (it selects on `embedding is null`).
import { createTracedClient } from './otel.ts';
import type { Span } from './otel.ts';
import type { DbClient } from './api/auth.ts';
import { embeddingInput, isEmbeddable, toVectorLiteral, resolveEmbeddingConfig } from './embedding.ts';
import { embedTexts } from './embedding-client.ts';

interface WaitUntilHost { waitUntil(p: Promise<unknown>): void }

/** The runtime's background-task hook, when it has one. */
function background(): WaitUntilHost | null {
  const rt = (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime as WaitUntilHost | undefined;
  return rt && typeof rt.waitUntil === 'function' ? rt : null;
}

/**
 * Queue an embedding for a memory that was just written.
 *
 * Returns synchronously. `enqueued` is reported on the span so a run can be
 * told from a skip without reading provider logs — "no embeddings appeared" has
 * three very different causes (disabled, unavailable runtime hook, provider
 * failing) and they should not look alike.
 */
export function embedOnWrite(
  db: DbClient,
  span: Span,
  memory: { id: string; key: string; value: string },
  env: Record<string, string | undefined>,
): void {
  const config = resolveEmbeddingConfig(env);
  if (!config.enabled) return;

  const text = embeddingInput(memory);
  if (!isEmbeddable(text)) return;

  const host = background();
  if (!host) {
    span.setAttributes({ 'lorekit.embedding.skipped': 'no_background_runtime' });
    return;
  }

  span.setAttributes({ 'lorekit.embedding.enqueued': true });

  // The outcome must be recorded on a DETACHED span, not on `span`.
  // `traceRequest` ends the request span and flushes its batch in a `finally`,
  // which runs before this callback resolves — anything written to `span` from
  // here on is added to a drained batch and never exported. That would leave
  // `enqueued` (set above, before the flush) as the only observable half of the
  // story, which is precisely the "three different causes look alike" failure
  // this module's reporting exists to prevent.
  const { span: bg, flush } = span.detachedChild('lorekit.embedding.write', {
    'lorekit.memory_id': memory.id,
    'lorekit.embedding.model': config.model,
  });

  host.waitUntil((async () => {
    try {
      const [vector] = await embedTexts([text], config);
      if (!vector) {
        bg.setAttributes({ 'lorekit.embedding.skipped': 'no_vector' });
        return;
      }
      // `embedding_model` is written in the SAME statement as the vector. The
      // 00060 CHECK requires both-or-neither, so splitting them would not merely
      // be untidy — it would be rejected.
      const { error } = await createTracedClient(db, bg)
        .from('memories')
        .update({ embedding: toVectorLiteral(vector), embedding_model: config.model })
        .eq('id', memory.id);
      if (error) bg.error(`embedding update: ${error.message}`);
    } catch (e) {
      // Swallowed on purpose. The memory is already saved; the backfill will
      // find this row again because its embedding is still null.
      bg.error(`embedding failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    } finally {
      bg.end();
      // Awaited: this task IS the isolate's keep-alive, so a fire-and-forget
      // export here can be torn down mid-flight.
      await flush();
    }
  })());
}
