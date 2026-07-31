import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import {
  bytesToBase64Url,
  base64ToBytes,
  pemToDer,
  derLength,
  wrapPkcs1DerInPkcs8,
  toPkcs8Der,
  encodeSigningInput,
} from './github-app-jwt';

const subtle = webcrypto.subtle;

describe('bytesToBase64Url', () => {
  it('encodes without padding and with url-safe alphabet', () => {
    // 0xFF 0xFF 0xFF -> "////" in base64 -> "____" url-safe
    expect(bytesToBase64Url(new Uint8Array([0xff, 0xff, 0xff]))).toBe('____');
    // 0xFB 0xFF -> "+/8=" -> url-safe, no pad -> "-_8"
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(bytesToBase64Url(new Uint8Array([]))).toBe('');
    expect(bytesToBase64Url(new Uint8Array([0x00]))).toBe('AA');
  });

  it('round-trips arbitrary bytes through base64ToBytes', () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;
    expect(base64ToBytes(bytesToBase64Url(original))).toEqual(original);
  });
});

describe('base64ToBytes', () => {
  it('ignores PEM whitespace, newlines, and padding', () => {
    // "TWFu" decodes to "Man"; interleave junk that must be dropped.
    expect(base64ToBytes('T W\nF u==')).toEqual(new Uint8Array([0x4d, 0x61, 0x6e]));
  });
});

describe('derLength', () => {
  it('uses short form below 128', () => {
    expect(derLength(0)).toEqual([0]);
    expect(derLength(127)).toEqual([127]);
  });
  it('uses long form at and above 128', () => {
    expect(derLength(128)).toEqual([0x81, 128]);
    expect(derLength(256)).toEqual([0x82, 0x01, 0x00]);
    expect(derLength(1200)).toEqual([0x82, 0x04, 0xb0]);
  });
});

describe('wrapPkcs1DerInPkcs8', () => {
  it('produces a SEQUENCE carrying the rsaEncryption OID and the pkcs1 payload', () => {
    const pkcs1 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const pkcs8 = wrapPkcs1DerInPkcs8(pkcs1);
    expect(pkcs8[0]).toBe(0x30); // outer SEQUENCE
    // rsaEncryption OID 1.2.840.113549.1.1.1
    const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
    const hay = Array.from(pkcs8).join(',');
    expect(hay).toContain(oid.join(','));
    // The pkcs1 payload is embedded verbatim at the tail (inside the OCTET STRING).
    expect(Array.from(pkcs8.slice(-4))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
});

describe('pemToDer', () => {
  it('strips armor and decodes the body', () => {
    const der = pemToDer('-----BEGIN PRIVATE KEY-----\nTWFu\n-----END PRIVATE KEY-----\n');
    expect(der).toEqual(new Uint8Array([0x4d, 0x61, 0x6e]));
  });
});

describe('encodeSigningInput', () => {
  it('emits two base64url segments that decode back to the JSON', () => {
    const input = encodeSigningInput({ alg: 'RS256', typ: 'JWT' }, { iss: '42', iat: 1, exp: 2 });
    const [h, p] = input.split('.');
    const dec = (s: string) => new TextDecoder().decode(base64ToBytes(s));
    expect(JSON.parse(dec(h))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(dec(p))).toEqual({ iss: '42', iat: 1, exp: 2 });
  });
});

// The load-bearing test: a JWT assembled + signed exactly as the edge shell
// does must verify against the matching public key — for BOTH a PKCS#8 key and
// a PKCS#1 key (proving the wrap). This is what actually breaks if the DER
// byte-twiddling is wrong, which unit assertions on individual helpers can't
// fully catch.
async function signVerify(privatePem: string, publicKeySpki: ArrayBuffer): Promise<boolean> {
  const signingInput = encodeSigningInput(
    { alg: 'RS256', typ: 'JWT' },
    { iss: 'app-id', iat: 100, exp: 700 },
  );
  const privKey = await subtle.importKey(
    'pkcs8',
    toPkcs8Der(privatePem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privKey,
    new TextEncoder().encode(signingInput),
  );
  const pubKey = await subtle.importKey(
    'spki',
    publicKeySpki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return subtle.verify(
    'RSASSA-PKCS1-v1_5',
    pubKey,
    sig,
    new TextEncoder().encode(signingInput),
  );
}

describe('toPkcs8Der end-to-end sign/verify', () => {
  it('signs with a PKCS#8 private key that verifies against its public key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    expect(await signVerify(privateKey as string, publicKey as unknown as ArrayBuffer)).toBe(true);
  });

  it('signs with a PKCS#1 private key (GitHub download form) after the pkcs8 wrap', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'der' },
    });
    expect(privateKey as string).toContain('BEGIN RSA PRIVATE KEY');
    expect(await signVerify(privateKey as string, publicKey as unknown as ArrayBuffer)).toBe(true);
  });
});
