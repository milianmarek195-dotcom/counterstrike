import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  // The monorepo root is the tracing root so the standalone build includes @celtist/shared.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  transpilePackages: ['@celtist/shared'],
  poweredByHeader: false,
  images: { remotePatterns: [{ protocol: 'https', hostname: 'community.cloudflare.steamstatic.com' }, { protocol: 'https', hostname: 'avatars.steamstatic.com' }, { protocol: 'https', hostname: 'avatars.akamai.steamstatic.com' }] },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
