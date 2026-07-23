import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    reactCompiler: false,
  },
  // Transpile mcp-core TypeScript source directly into the Next.js bundle
  transpilePackages: ['@lorekit/core'],
  webpack: (config) => {
    // mcp-core uses TypeScript's nodenext module resolution which requires
    // .js extensions in imports (e.g. './scope.js'). Webpack needs to know
    // to resolve those .js imports to the actual .ts source files.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
