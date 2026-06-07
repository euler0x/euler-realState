/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the SDK as a native external on the server (it uses import.meta.url / ESM-only).
  // Do NOT add to transpilePackages — Next.js 15 requires these lists to be mutually exclusive.
  serverExternalPackages: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
};

export default nextConfig;
