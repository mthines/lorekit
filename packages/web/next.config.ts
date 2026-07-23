import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    reactCompiler: false,
  },
  // Ensure packages/mcp-core is transpiled by Next.js
  transpilePackages: ['@lorekit/core'],
};

export default nextConfig;
