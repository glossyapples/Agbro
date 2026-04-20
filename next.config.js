/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', '@alpacahq/alpaca-trade-api'],
  },
};

module.exports = nextConfig;
