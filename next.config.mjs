/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the SDK as a native external on the server (it uses import.meta.url / ESM-only).
  // transpilePackages lets next/jest's SWC transformer process the .mjs bundle in tests.
  serverExternalPackages: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
  transpilePackages: ['@anthropic-ai/claude-agent-sdk'],
};

export default nextConfig;
