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

  it('offers an OLDER supported version, not a newer one, when it can', () => {
    // The regression this guards against. 2025-03-26 is deliberately
    // unsupported (it mandates JSON-RPC batching the handler does not
    // implement). Answering it with our newest version — 2025-06-18, released
    // AFTER it — would hand that client a revision it does not know and, per
    // spec, SHOULD disconnect over: the exact failure this module exists to
    // remove, reproduced for a different client. Offer 2024-11-05 instead,
    // which it almost certainly still speaks.
    expect(negotiateProtocolVersion({ protocolVersion: '2025-03-26' })).toBe('2024-11-05');
    // Any date between our two supported revisions behaves the same way.
    expect(negotiateProtocolVersion({ protocolVersion: '2025-01-01' })).toBe('2024-11-05');
  });

  it('falls back to the preferred version only when nothing older is supported', () => {
    // Older than everything we speak — there is no "not newer" candidate, so
    // our newest is the only offer we can make.
    expect(negotiateProtocolVersion({ protocolVersion: '1999-01-01' })).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
    // Newer than everything we speak: echo is impossible, and the newest we
    // have is both "not newer than requested" and our preferred version.
    expect(negotiateProtocolVersion({ protocolVersion: '2099-01-01' })).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
  });

  it('never offers a version newer than the client asked for', () => {
    // Property form of the two cases above, over a spread of plausible dates.
    for (const requested of [
      '2024-01-01',
      '2024-11-05',
      '2025-03-26',
      '2025-06-18',
      '2026-01-01',
    ]) {
      const answered = negotiateProtocolVersion({ protocolVersion: requested });
      if (requested >= SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]) {
        expect(answered <= requested, `${requested} → ${answered}`).toBe(true);
      }
    }
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
    // …and NOT a third, derived attribute. "Did we have to downgrade" is
    // `requested !== protocol_version`, computable at query time. A stored
    // boolean would need its name to explain which direction it reads, which
    // the first draft of this got backwards.
    expect(handler).not.toMatch(/mcp\.protocol_version\.negotiated/);
  });

  it('documents the MUSTs it does not yet meet for the version it claims', () => {
    // Claiming a revision means claiming its obligations. 2025-03-26 is
    // rejected here on exactly that basis, so the 2025-06-18 gaps have to be
    // written down rather than assumed away — otherwise the standard is being
    // applied in one direction only.
    const mod = readFileSync(path.resolve(here, './mcp-protocol-version.ts'), 'utf8');
    expect(mod).toMatch(/KNOWN GAPS/);
    for (const gap of ['202 Accepted', 'MCP-Protocol-Version', 'Origin']) {
      expect(mod, `known-gap list should mention ${gap}`).toContain(gap);
    }
  });
});
