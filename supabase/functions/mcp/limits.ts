/**
 * Abuse guardrails for the production Deno MCP edge function: a per-user cap
 * on stored (active) memories, and a per-user request rate limit.
 *
 * Self-contained mirror of packages/mcp-core/src/limits.ts — the edge
 * function has no cross-package imports (Deno / Node.js MCP SDK
 * incompatibility), so this module deliberately duplicates the logic rather
 * than importing it. Keep the two in sync when either changes.
 *
 * The DB (supabase/migrations/00004_limits.sql) is the single config source
 * and the authoritative enforcer for the cap (a BEFORE INSERT trigger) and
 * the rate limit (an atomic Postgres-backed fixed-window RPC). This module
 * only translates DB-layer rejections into actionable app-layer errors and
 * wraps the rate-limit RPC call.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import { createTracedClient, type Span } from '../_shared/otel.ts';

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
 * Pure decision for a fixed-window rate limit — no I/O, easily unit-testable.
 * `count` is the request count already recorded for the current window
 * (inclusive of the current request, as returned by lorekit_check_rate_limit).
 */
export function rateLimitDecision(
  count: number,
  limit: number,
  windowSeconds: number,
  now: Date = new Date(),
): { allowed: boolean; retryAfterSeconds: number } {
  const allowed = count <= limit;
  if (allowed) return { allowed: true, retryAfterSeconds: 0 };

  const nowSeconds = now.getTime() / 1000;
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const retryAfterSeconds = Math.max(0, Math.ceil(windowStart + windowSeconds - nowSeconds));
  return { allowed: false, retryAfterSeconds };
}

/**
 * Translate a DB error into an actionable LimitError when it was raised by
 * the enforce_memory_cap() trigger (SQLSTATE 'LK001'). Any other error is
 * returned unchanged so callers can rethrow/wrap it as before.
 */
// deno-lint-ignore no-explicit-any
export function translateCapError(err: any, limit?: number): unknown {
  const code = err?.code as string | undefined;
  if (code !== MEMORY_CAP_SQLSTATE) return err;

  const message = (err?.message as string | undefined) ?? '';
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
  db: ReturnType<typeof createClient>,
  userId: string,
  span: Span,
  windowSeconds = 60,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const tracedDb = createTracedClient(db, span);
  try {
    const { data, error } = await tracedDb.rpc('lorekit_check_rate_limit', {
      p_user_id: userId,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      span.error(`RateLimitRpcError: ${error.message}`);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      allowed: Boolean(row?.allowed),
      retryAfterSeconds: Number(row?.retry_after_seconds ?? 0),
    };
  } catch (err) {
    span.error(`RateLimitException: ${(err as Error).message}`);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
