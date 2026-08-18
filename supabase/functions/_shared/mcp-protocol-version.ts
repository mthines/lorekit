// MCP lifecycle: which protocol revisions this server speaks, and how an
// `initialize` request is answered.
//
// This is the EDGE MIRROR. The original lives at
// `packages/mcp-core/src/mcp-protocol-version.ts`; it is copied here because the
// Deno edge tree cannot cross-import that package, and the two are held
// byte-identical (modulo comments, which `executableSource` strips) by
// `edge-parity.spec.ts`. Behaviour is asserted on the mcp-core copy by
// `mcp-protocol-version.spec.ts` — edit the original, then re-mirror.
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
// KNOWN GAPS in the 2025-06-18 claim, recorded rather than glossed. Claiming a
// revision means claiming its MUSTs, and the same standard used to reject
// 2025-03-26 has to be applied honestly here. None of the three is a behaviour
// this module changes — they are all handler-side, and all three are unmet
// today — but they are NOT inherited obligations either. Each arrives with a
// revision this server has never claimed until now, so it is the version list
// on the line below that first puts us on the hook for them (the revision that
// introduces each is named):
//   1. `notifications/initialized` answers 204; the Streamable HTTP transport
//      (2025-03-26) says a notification MUST get 202 Accepted.
//   2. No `MCP-Protocol-Version` request-header handling (2025-06-18 adds the
//      header; an unsupported value MUST be answered 400). This one is created
//      outright by offering 2025-06-18 — before this change nothing asked for it.
//   3. No `Origin` header validation (Streamable HTTP, 2025-03-26).
// A caller doing basic tools/list + tools/call is unaffected by all three,
// which is why offering the version is still the right call — but fix them
// before treating this list as a conformance statement.
//
// Ordered NEWEST FIRST: index 0 is the newest revision we speak.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;

export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

// The version offered to a client that asks for nothing at all. The spec's
// "SHOULD respond with the latest version supported" applies to that case.
export const PREFERRED_PROTOCOL_VERSION: SupportedProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[0];

// The floor: the OLDEST revision we still speak, and the offer for a client
// asking for something older than everything on the list. There is no
// not-newer-than-requested candidate in that case, and answering with our
// newest would hand a very old client a revision released years after it —
// the same shape the 2025-03-26 path below exists to avoid. The oldest we
// speak is the closest legal offer available, and the likeliest to be
// understood. This is deliberately NOT `PREFERRED_PROTOCOL_VERSION`: that
// constant answers a client that expressed no preference at all, which is a
// different question.
export const OLDEST_PROTOCOL_VERSION: SupportedProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

export function isSupportedProtocolVersion(raw: unknown): raw is SupportedProtocolVersion {
  return (
    typeof raw === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(raw)
  );
}

// Read the client's requested `protocolVersion` out of an `initialize` params
// object and return the version to answer with.
//
// Echo it when we speak it. Otherwise offer the newest version we speak that is
// NOT NEWER than what was asked for, and fall back to the OLDEST version we
// speak when no such version exists.
//
// That middle rule is the whole point and it is easy to get wrong. Answering
// every unsupported request with our newest version reproduces the bug this
// module exists to fix, just for a different client: a 2025-03-26 client
// (a revision we deliberately do not claim — see above) would be told
// "2025-06-18", a version released after it, which it does not know and per
// spec SHOULD disconnect over. Offering 2024-11-05 instead — older than what it
// asked for, and therefore something it almost certainly still speaks — is
// equally legal ("a version the server supports") and actually connects.
// Dates sort lexicographically in YYYY-MM-DD, so the comparison is a plain
// string compare.
//
// Total by construction: `params` is caller-controlled JSON, so a missing,
// null, numeric, or structurally wrong value degrades to the preferred version
// rather than throwing. A handshake must never 500 on a malformed field it can
// simply ignore.
export function negotiateProtocolVersion(params: unknown): SupportedProtocolVersion {
  const requested = readRequestedProtocolVersion(params);
  if (requested === null) return PREFERRED_PROTOCOL_VERSION;
  if (isSupportedProtocolVersion(requested)) return requested;
  const notNewerThanRequested = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v <= requested);
  return notNewerThanRequested ?? OLDEST_PROTOCOL_VERSION;
}

// A protocol revision is a date, so anything longer than this is junk and must
// never reach a span attribute or a comparison.
const MAX_PROTOCOL_VERSION_LENGTH = 32;

// The raw, unvalidated value the client sent, for telemetry. Returned as a
// string only when it actually is one — anything else is reported as absent, so
// the attribute stays low-cardinality and never carries a serialised object.
export function readRequestedProtocolVersion(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const raw = (params as { protocolVersion?: unknown }).protocolVersion;
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_PROTOCOL_VERSION_LENGTH
    ? raw
    : null;
}

// The value recorded on the `mcp.protocol_version.requested` span attribute.
//
// `readRequestedProtocolVersion` collapses four distinct situations into a
// single `null` — the field is absent, it is not a string, it is empty, it is
// implausibly long — and folding those into one telemetry value defeats the
// attribute. A client sending something unexpected is exactly the signal it
// exists to catch, and it would read identically to a client sending nothing.
//
// Return the plausible value verbatim, and one distinct sentinel per failure
// otherwise. Be precise about what that bounds and what it does not: the
// SENTINEL set is closed and no sentinel is date-shaped, so a sentinel can
// never be mistaken for a real revision — but the attribute DOMAIN is not a
// closed set. Any string of at most MAX_PROTOCOL_VERSION_LENGTH characters is
// echoed as-is, including a nonsense one like `latest`, so cardinality is
// bounded by LENGTH, not by membership. That is deliberate: an unexpected value
// is the signal this attribute was added to carry, and narrowing the domain to
// date-shaped strings would throw it away to make a tidier claim true.
export function requestedProtocolVersionAttribute(params: unknown): string {
  if (typeof params !== 'object' || params === null) return 'unset';
  const raw = (params as { protocolVersion?: unknown }).protocolVersion;
  if (raw === undefined) return 'unset';
  if (typeof raw !== 'string') return 'not-a-string';
  if (raw.length === 0) return 'empty';
  if (raw.length > MAX_PROTOCOL_VERSION_LENGTH) return 'too-long';
  return raw;
}
