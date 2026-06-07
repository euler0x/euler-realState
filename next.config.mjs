/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the SDK as a native external on the server (it uses import.meta.url / ESM-only).
  // Do NOT add to transpilePackages — Next.js 15 requires these lists to be mutually exclusive.
  serverExternalPackages: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],

  experimental: {
    // Allow require()-ing ESM-only packages that are already in serverExternalPackages.
    // The agent SDK is pure ESM but loaded via createRequire for jest compatibility.
    esmExternals: 'loose',
  },
};

export default nextConfig;
