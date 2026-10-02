import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { AppConfig } from '../config/app-config.js';
import { RedisService } from '../redis/redis.service.js';

export const HTTP_FETCH = Symbol('HTTP_FETCH');
export type HttpFetch = typeof fetch;

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;
const NONCE_MAX_AGE_MS = 5 * 60_000;
const STATE_TTL_SECONDS = 600;
const REQUIRED_SIGNED_FIELDS = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce'];

export type OpenIdFailure =
  | 'STATE_MISSING'
  | 'STATE_MISMATCH'
  | 'MALFORMED_RESPONSE'
  | 'WRONG_ENDPOINT'
  | 'RETURN_TO_MISMATCH'
  | 'INVALID_CLAIMED_ID'
  | 'UNSIGNED_FIELDS'
  | 'NONCE_INVALID'
  | 'NONCE_REPLAYED'
  | 'VERIFICATION_FAILED'
  | 'STEAM_UNREACHABLE';

export class OpenIdError extends Error {
  constructor(
    readonly reason: OpenIdFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'OpenIdError';
  }
}

export type OpenIdQuery = Record<string, string | string[] | undefined>;

/** Only same-site relative paths are accepted as post-login targets (no open redirect). */
export function sanitizeReturnTo(input: string | undefined): string {
  if (!input || input.length > 200) return '/';
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) return '/';
  return input;
}

/**
 * Steam OpenID 2.0 relying party. Steam is the only identity provider; no passwords ever touch this system.
 *
 * Verification is deliberately strict and does not trust any field before Steam's `check_authentication`
 * confirms the signature: we additionally pin the endpoint, the return URL (including our one-time state),
 * the claimed-id format, the signed field list, and reject replayed or stale nonces.
 */
@Injectable()
export class SteamOpenIdService {
  private readonly logger = new Logger(SteamOpenIdService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly redis: RedisService,
    private readonly clock: Clock,
    @Inject(HTTP_FETCH) private readonly fetcher: HttpFetch,
  ) {}

  get loginEndpoint(): string {
    return `${this.config.env.STEAM_OPENID_URL.replace(/\/$/, '')}/login`;
  }

  get callbackUrl(): string {
    return `${this.config.env.PUBLIC_API_URL.replace(/\/$/, '')}/v1/auth/steam/callback`;
  }

  /** Starts a login: returns the Steam URL to redirect to and the one-time state for the browser cookie. */
  async startLogin(returnTo?: string): Promise<{ redirectUrl: string; state: string }> {
    const state = randomBytes(24).toString('base64url');
    await this.redis.client.set(`oid:state:${state}`, sanitizeReturnTo(returnTo), 'EX', STATE_TTL_SECONDS);

    const params = new URLSearchParams({
      'openid.ns': OPENID_NS,
      'openid.mode': 'checkid_setup',
      'openid.return_to': `${this.callbackUrl}?state=${state}`,
      'openid.realm': new URL(this.config.env.PUBLIC_API_URL).origin,
      'openid.identity': IDENTIFIER_SELECT,
      'openid.claimed_id': IDENTIFIER_SELECT,
    });
    return { redirectUrl: `${this.loginEndpoint}?${params.toString()}`, state };
  }

  /** Verifies the callback and returns the authenticated SteamID64 and the stored post-login path. */
  async completeLogin(query: OpenIdQuery, stateCookie: string | undefined): Promise<{ steamId: string; returnTo: string }> {
    const stateParam = single(query.state);
    if (!stateCookie || !stateParam) throw new OpenIdError('STATE_MISSING');
    if (!safeEqual(stateCookie, stateParam)) throw new OpenIdError('STATE_MISMATCH');

    // The state is single use: consume it before doing anything else.
    const stateKey = `oid:state:${stateParam}`;
    const returnTo = await this.redis.client.get(stateKey);
    if (returnTo === null) throw new OpenIdError('STATE_MISSING', 'State expired or already used');
    await this.redis.client.del(stateKey);

    const fields = this.collectOpenIdFields(query);
    if (fields.get('openid.ns') !== OPENID_NS || fields.get('openid.mode') !== 'id_res') {
      throw new OpenIdError('MALFORMED_RESPONSE');
    }
    if (fields.get('openid.op_endpoint') !== this.loginEndpoint) throw new OpenIdError('WRONG_ENDPOINT');
    this.assertReturnTo(fields.get('openid.return_to'), stateParam);

    const claimedId = fields.get('openid.claimed_id') ?? '';
    const match = CLAIMED_ID_PATTERN.exec(claimedId);
    if (!match || fields.get('openid.identity') !== claimedId) throw new OpenIdError('INVALID_CLAIMED_ID');

    const signed = new Set((fields.get('openid.signed') ?? '').split(','));
    if (!REQUIRED_SIGNED_FIELDS.every((field) => signed.has(field))) throw new OpenIdError('UNSIGNED_FIELDS');

    await this.assertFreshNonce(fields.get('openid.response_nonce'));
    await this.verifyWithSteam(fields);
    return { steamId: match[1]!, returnTo };
  }

  private collectOpenIdFields(query: OpenIdQuery): Map<string, string> {
    const fields = new Map<string, string>();
    for (const [key, value] of Object.entries(query)) {
      if (!key.startsWith('openid.')) continue;
      if (typeof value !== 'string') throw new OpenIdError('MALFORMED_RESPONSE', `Duplicate or empty field ${key}`);
      fields.set(key, value);
    }
    return fields;
  }

  private assertReturnTo(returnTo: string | undefined, state: string): void {
    let parsed: URL;
    let expected: URL;
    try {
      parsed = new URL(returnTo ?? '');
      expected = new URL(this.callbackUrl);
    } catch {
      throw new OpenIdError('RETURN_TO_MISMATCH');
    }
    if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname || parsed.searchParams.get('state') !== state) {
      throw new OpenIdError('RETURN_TO_MISMATCH');
    }
  }

  private async assertFreshNonce(nonce: string | undefined): Promise<void> {
    // Format: 2026-10-02T12:00:00Z<unique suffix>
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(.{1,100})$/.exec(nonce ?? '');
    if (!match) throw new OpenIdError('NONCE_INVALID');
    const issuedAt = Date.parse(match[1]!);
    if (!Number.isFinite(issuedAt) || Math.abs(this.clock.nowMs() - issuedAt) > NONCE_MAX_AGE_MS) {
      throw new OpenIdError('NONCE_INVALID', 'Nonce timestamp outside the accepted window');
    }
    const fresh = await this.redis.setIfAbsent(`oid:nonce:${nonce}`, NONCE_MAX_AGE_MS * 2);
    if (!fresh) throw new OpenIdError('NONCE_REPLAYED');
  }

  /** Direct verification: Steam confirms that it issued and signed exactly this response. */
  private async verifyWithSteam(fields: Map<string, string>): Promise<void> {
    const body = new URLSearchParams();
    for (const [key, value] of fields) body.set(key, value);
    body.set('openid.mode', 'check_authentication');

    let text: string;
    try {
      const response = await this.fetcher(this.loginEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new OpenIdError('STEAM_UNREACHABLE', `Steam answered ${response.status}`);
      text = await response.text();
    } catch (error) {
      if (error instanceof OpenIdError) throw error;
      this.logger.warn(`Steam verification request failed: ${(error as Error).message}`);
      throw new OpenIdError('STEAM_UNREACHABLE');
    }
    const valid = text.split(/\r?\n/).some((line) => line.trim() === 'is_valid:true');
    if (!valid) throw new OpenIdError('VERIFICATION_FAILED');
  }
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
