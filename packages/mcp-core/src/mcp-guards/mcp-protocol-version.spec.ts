import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
  negotiateProtocolVersion,
} from './mcp-protocol-version.js';

/**
 * The MCP lifecycle handshake: the server must NEGOTIATE `protocolVersion`, not
 * assert one.
 *
 * The spec is explicit — the server replies with the SAME version when it
 * supports the one the client asked for, and with a version it does support
 * otherwise; a client that receives a version it cannot speak "SHOULD
 * disconnect". A server that answers every `initialize` with one hard-coded
 * literal therefore turns "this client is newer than me" into a silent hang-up.
 *
 * That is not hypothetical here. Over 2026-08-16→17, 614 `initialize` spans all
 * carried `mcp.protocol_version = 2024-11-05`, and the one genuine external
 * caller in nineteen days connected twice, completed `initialize`, sent
 * `notifications/initialized`, and then issued no `tools/list` and no
 * `tools/call` before abandoning 46 s later.
 */
describe('negotiateProtocolVersion', () => {
  it('echoes the client version when the server supports it', () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(negotiateProtocolVersion({ protocolVersion: version })).toBe(version);
    }
  });

  it('offers the preferred version when the client asks for one we do not speak', () => {
    // 2025-03-26 is deliberately unsupported (it mandates JSON-RPC batching,
    // which the edge handler does not implement). The client gets our best
    // offer and decides — which is the spec's contract — instead of being told
    // we speak a version it may have dropped.
    expect(negotiateProtocolVersion({ protocolVersion: '2025-03-26' })).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
    expect(negotiateProtocolVersion({ protocolVersion: '1999-01-01' })).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
  });

  it('offers the preferred version when the client sends no version at all', () => {
    expect(negotiateProtocolVersion({})).toBe(PREFERRED_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(PREFERRED_PROTOCOL_VERSION);
  });

  it('ignores a non-string protocolVersion rather than throwing', () => {
    // Params are attacker-controlled: a number, object, or null must degrade to
    // the preferred version, never crash the handshake.
    for (const junk of [42, null, {}, [], true]) {
      expect(negotiateProtocolVersion({ protocolVersion: junk })).toBe(
        PREFERRED_PROTOCOL_VERSION,
      );
    }
  });

  it('prefers the newest supported version and never claims 2025-03-26', () => {
    expect(PREFERRED_PROTOCOL_VERSION).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2025-03-26');
  });
});

/**
 * Drift guard against the deployed edge handler. `edge-parity.spec.ts` proves
 * the mirrored MODULE matches; this proves the handler actually CALLS it and no
 * longer carries the hard-coded literal that caused the bug.
 *
 * Same source-scanning approach as `mcp-authz-status.spec.ts` — vitest cannot
 * import the Deno edge tree.
 */
describe('mcp-handler initialize negotiation guard', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const handler = readFileSync(
    path.resolve(here, '../../../supabase/functions/mcp/mcp-handler.ts'),
    'utf8',
  );

  it('derives the initialize response version from the negotiator', () => {
    expect(handler).toMatch(/negotiateProtocolVersion\(params\)/);
    expect(handler).toMatch(/protocolVersion: negotiated/);
  });

  it('no longer hard-codes a protocol version anywhere in the handler', () => {
    expect(handler).not.toMatch(/['"]2024-11-05['"]/);
  });

  it('records the negotiated version and what the client asked for', () => {
    // A span attribute fed by a literal measures the server, not the caller —
    // which is why the 100%-on-2024-11-05 reading was mistaken for evidence
    // about client versions for eleven days. Record both sides.
    expect(handler).toMatch(/'mcp\.protocol_version': negotiated/);
    expect(handler).toMatch(/mcp\.protocol_version\.requested/);
  });
});
