import { GatewayClient } from './client.js';
import { MockCs2Server } from './simulator.js';

/**
 * Usage (PowerShell):
 *   $env:MOCK_SERVER_ID="<uuid>"; $env:MOCK_SERVER_KEY="<hex key>"; npm run dev:mock-server
 * The id and key are shown once when you create the server in Admin → Servers.
 */
const serverId = process.env.MOCK_SERVER_ID;
const apiKey = process.env.MOCK_SERVER_KEY;
if (!serverId || !apiKey) {
  console.error('Set MOCK_SERVER_ID and MOCK_SERVER_KEY (shown once when the server is created in the admin panel).');
  process.exit(1);
}

const client = new GatewayClient({ baseUrl: process.env.MOCK_API_URL ?? 'http://localhost:4000', serverId, apiKeyHex: apiKey });
const server = new MockCs2Server(client, { roundMs: Number(process.env.MOCK_ROUND_MS ?? 400), log: (m) => console.log(`[mock-cs2] ${m}`) });

process.on('SIGINT', () => server.stop());
process.on('SIGTERM', () => server.stop());
console.log(`[mock-cs2] connecting as ${serverId}`);
await server.run();
