import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Every JSON-RPC notification is acknowledged, never answered MethodNotFound.
 *
 * A JSON-RPC 2.0 notification (a message with no `id`) gets no response body,
 * and MCP's HTTP transport accepts one with an empty 2xx. MCP clients send
 * `notifications/cancelled` whenever they abandon a request, and may send
 * `notifications/progress` or `notifications/roots/list_changed`. `handleMcp`
 * used to acknowledge only `notifications/initialized`, so every other
 * notification fell through to the unknown-method branch: HTTP 400, JSON-RPC
 * -32601, and `error.type=MethodNotFound` on the request span.
 *
 * Measured 2026-10-12→19 in production: 749 `notifications/cancelled` requests
 * answered 400 `MethodNotFound`, 10.7% of all MCP requests — an error rate the
 * clients did nothing to earn.
 *
 * Scans the Deno handler, which vitest cannot import — the same approach as
 * `mcp-method-guard-ordering.spec.ts` and `mcp-authz-status.spec.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const handler = readFileSync(
  path.resolve(here, '../../../../supabase/functions/mcp/mcp-handler.ts'),
  'utf8',
);

const ACK = "startsWith('notifications/')";
const FALLTHROUGH = 'MethodNotFound: ${method}';

/** The acknowledgement branch: from the prefix test to the end of its block. */
function ackBlock(): string {
  const start = handler.indexOf(ACK);
  expect(start, `no \`${ACK}\` branch in handleMcp`).toBeGreaterThan(-1);
  const end = handler.indexOf('\n  }', start);
  expect(end).toBeGreaterThan(start);
  return handler.slice(start, end);
}

describe('handleMcp acknowledges every JSON-RPC notification', () => {
  it('acknowledges by the notifications/ PREFIX, not one exact method name', () => {
    // An exact match on `notifications/initialized` is the defect: it leaves
    // `notifications/cancelled` and every other notification to the fallthrough.
    expect(handler).toMatch(/method\??\.startsWith\('notifications\/'\)/);
    expect(handler).not.toMatch(/method === 'notifications\/initialized'/);
  });

  it('answers a notification with an empty 2xx, not a JSON-RPC body', () => {
    expect(ackBlock()).toMatch(/return new Response\(null, \{ status: 204 \}\);/);
  });

  it('does not mark the span as an error for a notification', () => {
    // A notification is handled correctly by being acknowledged. Recording
    // `error.type` here would keep inflating the MCP error rate.
    const block = ackBlock();
    expect(block).not.toMatch(/clientError\(/);
    expect(block).not.toMatch(/\.error\(/);
    expect(block).not.toMatch(/jsonrpcError\(/);
  });

  it('is decided before the unknown-method fallthrough, so notifications/cancelled cannot reach it', () => {
    const ackIdx = handler.indexOf(ACK);
    const fallthroughIdx = handler.indexOf(FALLTHROUGH);
    expect(ackIdx).toBeGreaterThan(-1);
    expect(fallthroughIdx, 'MethodNotFound fallthrough not found').toBeGreaterThan(-1);
    expect(ackIdx).toBeLessThan(fallthroughIdx);
  });

  it('still answers a non-notification unknown method with MethodNotFound (-32601)', () => {
    // `resources/list`, `server/discover` and friends are requests the server
    // does not implement — they must keep their error.
    const fallthroughIdx = handler.indexOf(FALLTHROUGH);
    expect(fallthroughIdx).toBeGreaterThan(-1);
    const tail = handler.slice(fallthroughIdx);
    expect(tail).toMatch(/return jsonrpcError\(id, -32601, `Method not found: \$\{method\}`\);/);
  });
});
