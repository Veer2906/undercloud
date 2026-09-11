import { repoUrl } from './generated/contract'

// Source-code links shown in the header ("Undercloud.sol ↗", "rubric hash ↗"). Resolution order:
//   1. NEXT_PUBLIC_REPO_URL at build time (Vercel env var),
//   2. `repoUrl` written into generated/contract.ts by `pnpm sync` from REPO_URL in .env,
//   3. a placeholder that at least does not 404 (the GitHub search for the project name).
// Set REPO_URL in .env after the GitHub push and run `pnpm sync` so a judge's click lands on the real file.
export const REPO_URL = (process.env.NEXT_PUBLIC_REPO_URL || repoUrl || '').replace(/\/+$/, '')
export const HAS_REPO_URL = REPO_URL !== ''
const FALLBACK = 'https://github.com/search?q=undercloud+sealed+market+arbitrum+sepolia&type=repositories'
export const RUBRIC_URL = HAS_REPO_URL ? `${REPO_URL}/blob/main/contracts/rubric.md` : FALLBACK
export const CONTRACT_SRC_URL = HAS_REPO_URL ? `${REPO_URL}/blob/main/contracts/src/Undercloud.sol` : FALLBACK
