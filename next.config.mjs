/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3', '@anthropic-ai/claude-agent-sdk'],
};

export default nextConfig;
