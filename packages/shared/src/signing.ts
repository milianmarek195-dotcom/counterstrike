/**
 * Request signing between the CS2 plugin (or mock server) and the backend. Node-only: exposed through the
 * `@celtist/shared/signing` subpath so browser bundles never import `node:crypto`.
 *
 * serverKey  = HKDF-SHA256(masterSecret, salt = serverId, info = "celtist-server-key-v{keyVersion}")
 * signature  = hex(HMAC-SHA256(serverKey, canonicalString))
 * canonical  = METHOD \n pathWithQuery \n timestampMs \n nonce \n sha256hex(body)
 *
 * The derived key is shown to the operator once (on server creation / rotation) and is never stored.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADERS = {
  server: 'x-celtist-server',
  timestamp: 'x-celtist-timestamp',
  nonce: 'x-celtist-nonce',
  signature: 'x-celtist-signature',
} as const;

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function deriveServerKey(masterSecret: string, serverId: string, keyVersion: number): Buffer {
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new RangeError('keyVersion must be a positive integer');
  const derived = hkdfSync('sha256', masterSecret, serverId, `celtist-server-key-v${keyVersion}`, 32);
  return Buffer.from(derived);
}

export interface SignatureInput {
  method: string;
  /** Path including the query string exactly as sent, e.g. /server/v1/commands?wait=25 */
  pathWithQuery: string;
  timestampMs: number;
  nonce: string;
  body: string | Uint8Array;
}

export function canonicalString(input: SignatureInput): string {
  return [
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(input.timestampMs),
    input.nonce,
    sha256Hex(input.body),
  ].join('\n');
}

export function signRequest(key: Buffer | Uint8Array, input: SignatureInput): string {
  return createHmac('sha256', key).update(canonicalString(input)).digest('hex');
}

/** Constant-time comparison of a presented signature against the expected one. */
export function verifySignature(
  key: Buffer | Uint8Array,
  input: SignatureInput,
  presentedSignatureHex: string,
): boolean {
  const expected = Buffer.from(signRequest(key, input), 'hex');
  let presented: Buffer;
  try {
    presented = Buffer.from(presentedSignatureHex, 'hex');
  } catch {
    return false;
  }
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/** Timestamp within the allowed skew of `nowMs`. */
export function isTimestampFresh(timestampMs: number, nowMs: number, maxSkewMs: number): boolean {
  return Number.isFinite(timestampMs) && Math.abs(nowMs - timestampMs) <= maxSkewMs;
}
