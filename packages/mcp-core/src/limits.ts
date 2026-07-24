/**
 * Abuse guardrails shared by every write/request path: a per-user cap on
 * stored (active) memories, and a per-user request rate limit.
 *
 * The DB (supabase/migrations/00004_limits.sql) is the single config source
 * and the authoritative enforcer for the cap (a BEFORE INSERT trigger) and
 * the rate limit (an atomic Postgres-backed fixed-window RPC). This module
 * only translates DB-layer rejections into actionable app-layer errors and
 * wraps the rate-limit RPC call.
 *
 * Mirrored (self-contained, no cross-package import) in
 * supabase/functions/mcp/limits.ts for the Deno edge function.
 */
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTracer, getToolDurationHistogram } from './telemetry.js';

export type LimitErrorCode = 'memory_cap' | 'rate_limited';

/** Actionable error surfaced to the caller when a guardrail rejects a request. */
export class LimitError extends Error {
  code: LimitErrorCode;
  retryAfterSeconds?: number;

  constructor(code: LimitErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'LimitError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Custom SQLSTATE raised by the enforce_memory_cap() trigger. */
export const MEMORY_CAP_SQLSTATE = 'LK001';

const LOREKIT_URL = 'https://lorekit-io.vercel.app';

export function memoryCapMessage(limit?: number): string {
  const ceiling = limit ? `the free-tier limit of ${limit} stored memories` : 'your stored-memories limit';
  return `You've reached ${ceiling}. Archive or delete unused memories, or raise your limit — see ${LOREKIT_URL} (or contact support) to increase it.`;
}

export function rateLimitMessage(retryAfterSeconds: number): string {
  return `Too many requests — you're being rate limited. Retry after ${retryAfterSeconds}s, or raise your limit — see ${LOREKIT_URL} (or contact support) to increase it.`;
}

/**
 * Translate a DB error into an actionable LimitError when it was raised by
 * the enforce_memory_cap() trigger (SQLSTATE 'LK001'). Any other error is
 * returned unchanged so callers can rethrow it as-is.
 */
export function translateCapError(err: unknown, limit?: number): unknown {
  const code = (err as { code?: string } | null | undefined)?.code;
  if (code !== MEMORY_CAP_SQLSTATE) return err;

  const message = (err as { message?: string } | null | undefined)?.message ?? '';
  const parsedLimit = message.match(/limit=(\d+)/)?.[1];
  const effectiveLimit = parsedLimit ? Number(parsedLimit) : limit;

  return new LimitError('memory_cap', memoryCapMessage(effectiveLimit));
}

/**
 * Call the lorekit_check_rate_limit RPC and return the allow/deny decision.
 * Fails open (allows the request) on an RPC error — availability over strict
 * throttling; the cap trigger still protects storage during an outage.
 */
export async function checkRateLimit(
  db: SupabaseClient,
  userId: string,
  windowSeconds = 60,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const tracer = getTracer();
  const hist = getToolDurationHistogram();
  const startTime = Date.now();

  return tracer.startActiveSpan('lorekit.rate_limit.check', { kind: SpanKind.INTERNAL }, async (span) => {
    span.setAttribute('lorekit.tool.name', 'rate_limit.check');
    try {
      const { data, error } = await db.rpc('lorekit_check_rate_limit', {
        p_user_id: userId,
        p_window_seconds: windowSeconds,
      });

      if (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `RateLimitRpcError: ${error.message}` });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const row = (Array.isArray(data) ? data[0] : data) as
        | { allowed: boolean; retry_after_seconds: number }
        | undefined;
      const allowed = Boolean(row?.allowed);
      const retryAfterSeconds = Number(row?.retry_after_seconds ?? 0);
      span.setAttribute('lorekit.rate_limit.allowed', allowed);
      return { allowed, retryAfterSeconds };
    } catch (err) {
      const e = err as Error;
      span.setStatus({ code: SpanStatusCode.ERROR, message: `${e.name}: ${e.message}` });
      return { allowed: true, retryAfterSeconds: 0 };
    } finally {
      span.end();
      hist.record((Date.now() - startTime) / 1000, {
        'lorekit.tool.name': 'rate_limit.check',
        'lorekit.scope.type': 'global',
      });
    }
  });
}

