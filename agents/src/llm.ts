// Claude with a deterministic fallback (spec §5.8). Every call site passes a same-schema fallback,
// so the demo runs end-to-end with no ANTHROPIC_API_KEY; only the prose differs.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import { env } from './env.js'

export const MODEL = env.LLM_MODEL || 'claude-opus-5'
// timeout is milliseconds in the TS SDK.
const client = env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 90_000, maxRetries: 2 }) : null
export const hasLLM = client !== null
export const llmMode = client ? `claude (${MODEL})` : 'deterministic (no ANTHROPIC_API_KEY)'

export type Effort = 'low' | 'medium' | 'high'
export type Judged<T> = { value: T; source: 'claude' | 'deterministic' }

/** Ask Claude for a typed object; fall back to `fallback()` when there is no key or on any API failure. */
export async function judge<T extends z.ZodTypeAny>(o: {
  system: string
  user: string
  schema: T
  effort: Effort
  fallback: () => z.infer<T>
}): Promise<Judged<z.infer<T>>> {
  if (!client) return { value: o.fallback(), source: 'deterministic' }
  try {
    // Opus 5 / Sonnet 5 run adaptive thinking by default: never pass `thinking`; depth is `effort`.
    // Haiku 4.5 does not support `effort`, so it is omitted there.
    const output_config = MODEL.startsWith('claude-haiku')
      ? { format: zodOutputFormat(o.schema) }
      : { format: zodOutputFormat(o.schema), effort: o.effort }
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: o.system,
      messages: [{ role: 'user', content: o.user }],
      output_config,
    })
    if (res.stop_reason !== 'end_turn' || !res.parsed_output) throw new Error(`stop_reason ${res.stop_reason}`)
    // Re-validate: zodOutputFormat cannot express every constraint (min/max/enum land in descriptions).
    return { value: o.schema.parse(res.parsed_output), source: 'claude' }
  } catch (err) {
    const why = err instanceof Anthropic.APIError ? `${err.status} ${err.name}` : (err as Error).message
    console.warn(`[llm] ${why} -> deterministic`)
    return { value: o.fallback(), source: 'deterministic' }
  }
}
