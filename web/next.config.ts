import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // web/ is built standalone (own lockfile, deployed to Vercel from this directory);
  // pin the Turbopack root here so the monorepo's pnpm-workspace.yaml is never consulted.
  turbopack: { root: process.cwd() },
  // `next dev` would otherwise drop generated AGENTS.md / CLAUDE.md into web/ on every run.
  agentRules: false,
}

export default nextConfig
