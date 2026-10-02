import { randomUUID } from 'node:crypto';
import { SIGNATURE_HEADERS, signRequest } from '@celtist/shared/signing';

export interface GatewayClientOptions {
  baseUrl: string;
  serverId: string;
  /** Hex key shown once when the server was created in the admin panel. */
  apiKeyHex: string;
  fetchImpl?: typeof fetch;
}

/** Signs every request exactly like the plugin does (see docs/PLUGIN.md → "Request signing"). */
export class GatewayClient {
  private readonly key: Buffer;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GatewayClientOptions) {
    this.key = Buffer.from(options.apiKeyHex, 'hex');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; data: T }> {
    const json = body === undefined ? '' : JSON.stringify(body);
    const timestampMs = Date.now();
    const nonce = randomUUID();
    const signature = signRequest(this.key, { method, pathWithQuery: path, timestampMs, nonce, body: json });
    const response = await this.fetchImpl(this.options.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        [SIGNATURE_HEADERS.server]: this.options.serverId,
        [SIGNATURE_HEADERS.timestamp]: String(timestampMs),
        [SIGNATURE_HEADERS.nonce]: nonce,
        [SIGNATURE_HEADERS.signature]: signature,
      },
      body: body === undefined ? undefined : json,
      signal,
    });
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : undefined) as T };
  }
}
