// Prints fresh random secrets for .env. Usage: node scripts/generate-secrets.mjs
import { randomBytes } from 'node:crypto';

const hex = (bytes) => randomBytes(bytes).toString('hex');

console.log(`SESSION_SECRET=${hex(48)}`);
console.log(`SERVER_API_SECRET=${hex(48)}`);
console.log(`ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`);
