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
import type { SuppliedEmbedding } from './embedding.ts';
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
 * Returns synchronously. `enqueued` is reported on the span so a skip can be
 * told from a failure without reading provider logs — "no embeddings appeared"
 * has several very different causes and they should not look alike.
 *
 * The PER-REQUEST causes each carry their own signal: an unavailable runtime
 * hook, a memory with no embeddable text, a provider fault, and a write that
 * matched no row. `disabled` deliberately does NOT: it is a deployment-wide
 * constant (the flag and the key), it is the DEFAULT state, and stamping every
 * `POST /memories` on every project with an attribute recording a value that is
 * already in the configuration is noise on the busiest span in the system. An
 * operator asking "why are there no embeddings" reads the flag first; the span
 * is for the causes the flag cannot explain.
 *
 * ── `supplied`: the caller brought its own vector ─────────────────────────
 *
 * When the write carried an `embedding` + `embedding_model` pair, that vector
 * is stored as-is and NO provider is called. It therefore BYPASSES
 * `config.enabled`, which is the point: that flag guards spending money, and a
 * vector the caller already computed costs this deployment nothing. Opting in
 * per write is the only way a free hosted service can offer embeddings at all,
 * and it works on a deployment that has no provider key configured.
 *
 * It also bypasses the embeddable-text check, because the caller's vector is
 * the evidence — what text it was computed over is theirs to decide, and a
 * memory with an empty body can still legitimately carry one.
 *
 * Everything after that point is identical, deliberately: the same detached
 * span, the same background task, the same authorising RPC. A supplied vector
 * gets no privileged path into the column.
 *
 * `lorekit.embedding.source` (`client` | `provider`) tells the two apart, so
 * "who is actually embedding" is answerable without correlating against
 * provider bills.
 */
export function embedOnWrite(
  db: DbClient,
  span: Span,
  memory: { id: string; key: string; value: string },
  env: Record<string, string | undefined>,
  actor: string | null,
  supplied: SuppliedEmbedding | null = null,
): void {
  const config = resolveEmbeddingConfig(env);

  // Only the provider path needs text, a key, and the flag. Resolved up front
  // so the rest of the function is one flow over `(model, vector-source)`
  // rather than two near-copies that could drift on the authorisation call.
  let text = '';
  if (!supplied) {
    if (!config.enabled) return;

    // This one IS per-row and was silent: a memory whose key and value are empty
    // or whitespace can never be embedded, and without a signal it looked the same
    // as embedding being switched off. Rare enough to cost nothing, and it is the
    // difference between "this project embeds nothing" and "this lesson is empty".
    text = embeddingInput(memory);
    if (!isEmbeddable(text)) {
      span.setAttributes({ 'lorekit.embedding.skipped': 'no_embeddable_text' });
      return;
    }
  }

  const model = supplied ? supplied.model : config.model;

  // Applies to a supplied vector too, and that is a real (if theoretical) loss:
  // the caller computed something and it is dropped, where the provider path
  // would be picked up later by the backfill. Awaiting instead is NOT the
  // answer — this module exists to keep the write path free of an embedding's
  // latency, and a special case here would be the crack that lets it back in.
  // Every runtime this code deploys to (Supabase Edge / Deno Deploy) has
  // `waitUntil`, so the branch is a guard rather than a fallback, and the signal
  // names it precisely when it is not.
  const host = background();
  if (!host) {
    span.setAttributes({ 'lorekit.embedding.skipped': 'no_background_runtime' });
    return;
  }

  span.setAttributes({
    'lorekit.embedding.enqueued': true,
    'lorekit.embedding.source': supplied ? 'client' : 'provider',
  });

  // The outcome must be recorded on a DETACHED span, not on `span`.
  // `traceRequest` ends the request span and flushes its batch in a `finally`,
  // which runs before this callback resolves — anything written to `span` from
  // here on is added to a drained batch and never exported. That would leave
  // `enqueued` (set above, before the flush) as the only observable half of the
  // story, which is precisely the "three different causes look alike" failure
  // this module's reporting exists to prevent.
  const { span: bg, flush } = span.detachedChild('lorekit.embedding.write', {
    'lorekit.memory_id': memory.id,
    'lorekit.embedding.model': model,
  });

  host.waitUntil((async () => {
    try {
      // No empty-vector branch: `parseEmbeddingResponse` is strict on purpose
      // and THROWS unless it returns exactly one validated vector for one
      // input, so a `!vector` guard here could never fire. It is caught below
      // as an `embedding failed:` error like every other provider fault. A
      // supplied vector reaches here already validated by
      // `parseSuppliedEmbedding` at the edge, where a bad one is a 400 the
      // caller can read rather than an error swallowed in here.
      const vector = supplied ? supplied.vector : (await embedTexts([text], config))[0];
      // Written through `lorekit_memory_set_embedding` (00062) rather than a
      // direct `.update()`, and the reason is an asymmetry in the policies: the
      // READ policies were widened for orgs in 00015, `rls_update` (00001) was
      // not. An org-owned memory carries `user_id is null` (00019), so under a
      // JWT client the direct update matched ZERO ROWS — and PostgREST does not
      // call that an error. Every org memory silently went unembedded.
      //
      // The RPC authorises inside itself from the schema's own predicates
      // (`lorekit_org_actor` + `lorekit_org_can`, or actor identity for a
      // personal row), so this call site does not restate an ownership rule it
      // would then have to keep in step with 00019 by review alone.
      //
      // `embedding_model` goes in the SAME statement as the vector: the 00060
      // CHECK requires both-or-neither, so splitting them would be rejected.
      //
      // `.single()` because the RPC RETURNS TABLE, the same shape (and the same
      // reason) as `memory_delete` in `handlers/remove.ts`.
      const { data, error } = await createTracedClient(db, bg)
        .rpc<{ written: boolean }>('lorekit_memory_set_embedding', {
          p_memory_id: memory.id,
          p_actor_user_id: actor,
          p_embedding: toVectorLiteral(vector),
          p_model: model,
        })
        .single();
      if (error) bg.error(`embedding update: ${error.message}`);
      // A miss is REPORTED, never assumed benign. This is the half of the fix
      // that outlives the specific bug: if a future ownership model escapes the
      // RPC's predicates, it shows up here as a signal instead of an empty
      // column nobody notices until a semantic search comes back thin. The row
      // stays null and the backfill collects it, exactly as on a provider fault.
      else if (data?.written === false) {
        bg.error(`embedding update matched no row: memory ${memory.id} not writable by this caller`);
      }
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
