# Undercloud dashboard

Read-only Next.js 16 + viem dashboard for the Undercloud contract on Arbitrum Sepolia (no wallet; it rebuilds every deal from contract events). The contract address/ABI live in `src/lib/generated/contract.ts`, written by `pnpm sync` at the repo root. Labels are rendered exactly as the buyer saw them: accelerator, GPU-count bucket, region, interconnect, availability window (months), price band, claim type - never a provider, site, exact count or exact price.
Run: `pnpm install && pnpm dev` (or `pnpm build` then `vercel --prod`). Local chain: set `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_UNDERCLOUD_ADDRESS`, `NEXT_PUBLIC_DEPLOY_BLOCK`.
