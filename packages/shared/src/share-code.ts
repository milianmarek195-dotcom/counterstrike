/**
 * Loadout share codes, e.g. CELTIST-X7K2P9.
 * The code is an opaque random lookup key: it carries no player data and no loadout content.
 */

export const SHARE_CODE_PREFIX = 'CELTIST';
export const SHARE_CODE_LENGTH = 6;
/** Unambiguous alphabet: no 0/O, 1/I/L. 31 symbols ≈ 887 million codes. */
export const SHARE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const SHARE_CODE_PATTERN = new RegExp(`^${SHARE_CODE_PREFIX}-[${SHARE_CODE_ALPHABET}]{${SHARE_CODE_LENGTH}}$`);

export type RandomBytes = (length: number) => Uint8Array;

function webCryptoBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/**
 * Generates a code with unbiased sampling (rejection sampling on random bytes).
 * `randomBytes` is injectable so tests are deterministic.
 */
export function generateShareCode(randomBytes: RandomBytes = webCryptoBytes): string {
  const limit = 256 - (256 % SHARE_CODE_ALPHABET.length);
  let out = '';
  while (out.length < SHARE_CODE_LENGTH) {
    for (const byte of randomBytes(SHARE_CODE_LENGTH * 2)) {
      if (byte < limit) {
        out += SHARE_CODE_ALPHABET[byte % SHARE_CODE_ALPHABET.length];
        if (out.length === SHARE_CODE_LENGTH) break;
      }
    }
  }
  return `${SHARE_CODE_PREFIX}-${out}`;
}

/**
 * Accepts user input in any casing, with or without prefix/separators ("celtist x7k2p9", "X7K2P9"),
 * and returns the canonical form, or null if it cannot be a valid code.
 */
export function normalizeShareCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = compact.startsWith(SHARE_CODE_PREFIX) ? compact.slice(SHARE_CODE_PREFIX.length) : compact;
  const code = `${SHARE_CODE_PREFIX}-${body}`;
  return SHARE_CODE_PATTERN.test(code) ? code : null;
}

export function isValidShareCode(code: string): boolean {
  return SHARE_CODE_PATTERN.test(code);
}
