/** @type {import('next').NextConfig} */
const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
  {
    // Minimal CSP suited to a same-origin Next.js app. 'unsafe-inline' on scripts/styles
    // is required for Next.js hydration inlines; tighten with nonces once we move to
    // Next 15 strict-dynamic. 'unsafe-eval' is intentionally omitted.
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Previously set output: 'standalone' for smaller Docker images, but
  // Railway runs `next start` from package.json which is incompatible
  // with standalone output (that path needs `node .next/standalone/
  // server.js`). Dropping to the default server build so `next start
  // -p $PORT` works out of the box on Railway.
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', '@alpacahq/alpaca-trade-api'],
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

module.exports = nextConfig;
