/**
 * Pure, import-free helpers for minting a GitHub App JWT (RS256).
 *
 * A GitHub App authenticates to the REST API with a short-lived JWT signed by
 * the App's RSA private key (RS256).  This module holds the deterministic,
 * side-effect-free byte work — base64url encoding, PEM → DER parsing, the
 * PKCS#1 → PKCS#8 wrap GitHub's downloaded key needs, and the JWT signing-input
 * assembly.  The actual signature (Web Crypto `crypto.subtle.sign`) and the
 * env reads live in the impure shell (supabase/functions/mcp/github-app-client.ts),
 * which is the only place `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` are touched.
 *
 * This is the tested source of truth.  It is mirrored byte-for-byte (no
 * cross-package import) into supabase/functions/mcp/github-app-jwt.ts for the
 * Deno edge function — the same pattern as webhook-installation.ts /
 * webhook-secret-select.ts.  Drift is caught by edge-parity.spec.ts.
 *
 * Security posture: pure and stateless.  No I/O, no network, no env reads, no
 * clock.  Everything time- or secret-dependent belongs in the caller.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Encode raw bytes as base64url (RFC 4648 §5): '+' → '-', '/' → '_', no '='
 * padding.  Hand-rolled so the module needs neither `btoa` (absent in some
 * runtimes/types) nor `Buffer` and stays byte-identical in Node and Deno.
 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? BASE64URL_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '';
    out += i + 2 < bytes.length ? BASE64URL_ALPHABET[b2 & 63] : '';
  }
  return out;
}

/**
 * Decode a base64 (or base64url) string to bytes.  Ignores any character
 * outside the base64 alphabet — newlines, spaces, and '=' padding are dropped —
 * so it accepts the body of a PEM block verbatim.
 */
export function base64ToBytes(input: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const val = ch === '-' ? 62 : ch === '_' ? 63 : BASE64_ALPHABET.indexOf(ch);
    if (val < 0) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Strip the PEM armor and decode the base64 body to DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '');
  return base64ToBytes(body);
}

/** DER length octets for a content length: short form < 128, else long form. */
export function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const octets: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    octets.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return [0x80 | octets.length, ...octets];
}

/**
 * Wrap a PKCS#1 RSAPrivateKey (GitHub's `BEGIN RSA PRIVATE KEY` download) in a
 * PKCS#8 PrivateKeyInfo, which is the only RSA form Web Crypto's `importKey`
 * accepts.  The wrap is a fixed SEQUENCE:
 *   SEQUENCE { INTEGER 0, AlgorithmIdentifier{ rsaEncryption, NULL }, OCTET STRING(pkcs1) }
 */
export function wrapPkcs1DerInPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaEncryptionOid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  const algIdContent = [...rsaEncryptionOid, 0x05, 0x00];
  const algId = [0x30, ...derLength(algIdContent.length), ...algIdContent];
  const version = [0x02, 0x01, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length), ...pkcs1];
  const seqContent = [...version, ...algId, ...octet];
  return Uint8Array.from([0x30, ...derLength(seqContent.length), ...seqContent]);
}

/**
 * Parse a private-key PEM to PKCS#8 DER bytes ready for `importKey('pkcs8', …)`.
 * A `BEGIN RSA PRIVATE KEY` (PKCS#1) block is wrapped; a `BEGIN PRIVATE KEY`
 * (PKCS#8) block is returned as-is.
 */
export function toPkcs8Der(pem: string): Uint8Array {
  const der = pemToDer(pem);
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) return wrapPkcs1DerInPkcs8(der);
  return der;
}

/**
 * Assemble the JWT signing input `base64url(header).base64url(payload)`.  The
 * caller signs this string's UTF-8 bytes and appends `.base64url(signature)`.
 */
export function encodeSigningInput(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const encoder = new TextEncoder();
  const headerSegment = bytesToBase64Url(encoder.encode(JSON.stringify(header)));
  const payloadSegment = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${headerSegment}.${payloadSegment}`;
}
