import { config } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// One .env at the repo root is the source of truth; agents/.env can override.
config({ path: resolve(here, '../../.env'), quiet: true })
config({ path: resolve(here, '../.env'), override: true, quiet: true })

export const env = process.env

/** `pnpm demo` = short (two scenes: a sale, a dispute); `pnpm demo:full` = full (six scenes). */
export const DEMO_MODE: 'short' | 'full' = env.DEMO_MODE === 'full' ? 'full' : 'short'
