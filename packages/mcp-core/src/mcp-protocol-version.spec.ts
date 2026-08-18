import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  PREFERRED_PROTOCOL_VERSION,
  OLDEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  requestedProtocolVersionAttribute,
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

  it('falls back to the OLDEST supported version when nothing older is supported', () => {
    // Older than everything we speak — there is no "not newer than requested"
    // candidate, so no legal offer can satisfy the property. Offer the oldest
    // revision we speak rather than the newest: answering a 1999 client with
    // 2025-06-18 is the same "handed a revision released after you" shape the
    // 2025-03-26 case above exists to remove.
    expect(negotiateProtocolVersion({ protocolVersion: '1999-01-01' })).toBe(
      OLDEST_PROTOCOL_VERSION,
    );
    // Newer than everything we speak: echo is impossible, and the newest we
    // have is both "not newer than requested" and our preferred version.
    expect(negotiateProtocolVersion({ protocolVersion: '2099-01-01' })).toBe(
      PREFERRED_PROTOCOL_VERSION,
    );
  });

  it('never offers a version newer than the client asked for, except below our floor', () => {
    // Property form of the two cases above, over a spread of plausible dates.
    //
    // The property is universal only AT OR ABOVE the oldest revision we speak.
    // Below that floor it cannot hold — there is no older version left to
    // offer — so that input is asserted explicitly rather than skipped by a
    // guard the test name does not mention. `2024-01-01` is exactly that case,
    // and an earlier draft of this test quietly exempted it while the name
    // still promised a universal guarantee.
    for (const requested of [
      '2024-01-01',
      '2024-11-05',
      '2025-03-26',
      '2025-06-18',
      '2026-01-01',
    ]) {
      const answered = negotiateProtocolVersion({ protocolVersion: requested });
      if (requested >= OLDEST_PROTOCOL_VERSION) {
        expect(answered <= requested, `${requested} → ${answered}`).toBe(true);
      } else {
        // The one documented exemption: below the floor we answer with the
        // floor, which is necessarily newer than what was asked for.
        expect(answered, `${requested} → ${answered}`).toBe(OLDEST_PROTOCOL_VERSION);
      }
    }
  });

  it('degrades sanely when the requested version is not date-shaped', () => {
    // `readRequestedProtocolVersion` validates type and length only, so the
    // `v <= requested` comparison in the negotiator also runs on strings that
    // are not dates. That is deliberate — a handshake must answer a malformed
    // field with an offer rather than an error — but the answers are then
    // decided by codepoint order, so pin them rather than leave them incidental.
    //
    // 'latest' sorts after every date we speak, so every supported version is
    // "not newer than" it and the newest one wins.
    expect(negotiateProtocolVersion({ protocolVersion: 'latest' })).toBe('2025-06-18');
    // A truncated date sorts between our two revisions.
    expect(negotiateProtocolVersion({ protocolVersion: '2025' })).toBe('2024-11-05');
    // A string sorting before every date we speak hits the floor.
    expect(negotiateProtocolVersion({ protocolVersion: '1' })).toBe(OLDEST_PROTOCOL_VERSION);

    // The invariant that actually matters, whatever the junk: we only ever
    // answer with a version we genuinely speak.
    for (const junk of ['latest', '2025', 'v1', '1', 'zzz', '####', ' ']) {
      const answered = negotiateProtocolVersion({ protocolVersion: junk });
      expect(SUPPORTED_PROTOCOL_VERSIONS, `${junk} → ${answered}`).toContain(answered);
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
    // Newest-first ordering is the load-bearing invariant, so assert the
    // ORDERING rather than restating how the two constants are defined.
    // `expect(OLDEST).toBe(SUPPORTED[length - 1])` is how OLDEST is written, so
    // it holds for any array and catches nothing. What can actually go wrong is
    // a mis-ordered insert — re-adding `2025-03-26`, which this module
    // explicitly invites once the handler parses batches — which would silently
    // make `PREFERRED` not the newest and break `.find(v => v <= requested)`,
    // whose "newest match wins" behaviour depends entirely on this order.
    expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual(
      [...SUPPORTED_PROTOCOL_VERSIONS].sort().reverse(),
    );
    expect(OLDEST_PROTOCOL_VERSION).not.toBe(PREFERRED_PROTOCOL_VERSION);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2024-11-05');
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2025-03-26');
  });
});

describe('requestedProtocolVersionAttribute', () => {
  it('is bounded by LENGTH, not by membership — a plausible nonsense value is echoed', () => {
    // The attribute domain is deliberately open: any string of <= 32 chars
    // comes through as-is, because an unexpected value is the signal this
    // attribute exists to carry. Only the sentinels below are a closed set, and
    // conflating the two is how the first draft of this comment overclaimed.
    expect(requestedProtocolVersionAttribute({ protocolVersion: 'latest' })).toBe('latest');
    expect(requestedProtocolVersionAttribute({ protocolVersion: 'v1' })).toBe('v1');
    // The 32-char ceiling is the only cardinality guard: it keeps a large blob
    // off the span, it does not make the value set enumerable.
    expect(requestedProtocolVersionAttribute({ protocolVersion: 'z'.repeat(32) })).toBe(
      'z'.repeat(32),
    );
    expect(requestedProtocolVersionAttribute({ protocolVersion: 'z'.repeat(33) })).toBe(
      'too-long',
    );
  });

  it('records a plausible client version verbatim', () => {
    expect(requestedProtocolVersionAttribute({ protocolVersion: '2025-06-18' })).toBe(
      '2025-06-18',
    );
    // Including one we do NOT support — the attribute reports what the client
    // asked for, not what we answered.
    expect(requestedProtocolVersionAttribute({ protocolVersion: '2025-03-26' })).toBe(
      '2025-03-26',
    );
  });

  it('tells the four "no usable value" cases apart instead of collapsing them', () => {
    // The whole point of the attribute: a client sending something unexpected
    // must not read the same as a client sending nothing.
    expect(requestedProtocolVersionAttribute({})).toBe('unset');
    expect(requestedProtocolVersionAttribute(undefined)).toBe('unset');
    expect(requestedProtocolVersionAttribute({ protocolVersion: undefined })).toBe('unset');
    expect(requestedProtocolVersionAttribute({ protocolVersion: 42 })).toBe('not-a-string');
    expect(requestedProtocolVersionAttribute({ protocolVersion: null })).toBe('not-a-string');
    expect(requestedProtocolVersionAttribute({ protocolVersion: {} })).toBe('not-a-string');
    expect(requestedProtocolVersionAttribute({ protocolVersion: '' })).toBe('empty');
    expect(requestedProtocolVersionAttribute({ protocolVersion: 'x'.repeat(33) })).toBe(
      'too-long',
    );
  });

  it('keeps the SENTINEL set closed and not date-shaped', () => {
    // Every rejection maps into this fixed set — that is what "closed" means
    // here, and it is the only closed part.
    const sentinels = ['unset', 'not-a-string', 'empty', 'too-long'];
    for (const junk of [undefined, null, 42, {}, [], true, '', 'y'.repeat(64)]) {
      const value = requestedProtocolVersionAttribute({ protocolVersion: junk });
      expect(sentinels, `${String(junk)} → ${value}`).toContain(value);
      // Not date-shaped, so a sentinel can never be read as a real revision.
      expect(value).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
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
    // …via the classifier, not `requested ?? 'unset'`, which reported "no
    // protocolVersion", "not a string", "empty" and "over-long" identically —
    // erasing the unexpected-client signal the attribute exists to carry.
    expect(handler).toMatch(/requestedProtocolVersionAttribute\(params\)/);
    expect(handler).not.toMatch(/requested \?\? 'unset'/);
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
