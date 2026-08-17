// MCP lifecycle: which protocol revisions this server speaks, and how an
// `initialize` request is answered.
//
// Mirrored verbatim into `supabase/functions/_shared/mcp-protocol-version.ts`
// (the Deno edge tree cannot cross-import this package) and guarded by
// `edge-parity.spec.ts`. Behaviour is asserted here, on the mcp-core copy, by
// `mcp-protocol-version.spec.ts`.
//
// WHY THIS EXISTS. The `initialize` handler used to answer every client with a
// hard-coded `'2024-11-05'`, ignoring `params.protocolVersion` entirely. The
// spec makes negotiation the server's job: reply with the SAME version when the
// requested one is supported, otherwise reply with a version the server does
// support — and a client that cannot speak what comes back SHOULD disconnect.
// So a hard-coded answer does not degrade gracefully for a newer client; it
// converts "we disagree on a version" into a silent hang-up right after the
// handshake, which is precisely the shape observed in production (`initialize`
// → `notifications/initialized` → nothing).
//
// WHY 2025-03-26 IS ABSENT. It is not an oversight. That revision requires a
// server to accept JSON-RPC *batches* (an array of requests in one POST), and
// the edge handler reads a single object out of `req.json()`. Claiming support
// we do not have would trade a legible handshake mismatch for a confusing
// runtime one on the first batched call. A client asking for 2025-03-26 gets
// our preferred version instead and decides for itself — which is exactly the
// contract the spec defines for an unsupported request. Re-add it here (and
// only here) once the handler parses batches.
//
// Ordered NEWEST FIRST: index 0 is what we offer when there is nothing to echo.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;

export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

// The version offered when the client asks for one we do not speak, or asks for
// nothing at all. The newest we support, per the spec's "SHOULD respond with
// the latest version supported".
export const PREFERRED_PROTOCOL_VERSION: SupportedProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[0];

export function isSupportedProtocolVersion(raw: unknown): raw is SupportedProtocolVersion {
  return (
    typeof raw === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(raw)
  );
}

// Read the client's requested `protocolVersion` out of an `initialize` params
// object and return the version to answer with.
//
// Total by construction: `params` is caller-controlled JSON, so a missing,
// null, numeric, or structurally wrong value degrades to the preferred version
// rather than throwing. A handshake must never 500 on a malformed field it can
// simply ignore.
export function negotiateProtocolVersion(params: unknown): SupportedProtocolVersion {
  const requested = readRequestedProtocolVersion(params);
  return isSupportedProtocolVersion(requested) ? requested : PREFERRED_PROTOCOL_VERSION;
}

// The raw, unvalidated value the client sent, for telemetry. Returned as a
// string only when it actually is one — anything else is reported as absent, so
// the attribute stays low-cardinality and never carries a serialised object.
export function readRequestedProtocolVersion(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const raw = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 32 ? raw : null;
}
