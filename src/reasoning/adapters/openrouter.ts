import type { ReasoningTransportAdapter } from '../types'

/**
 * OpenRouter transport.
 *
 * Empirically verified against `@openrouter/ai-sdk-provider`:
 * `{ reasoning: { effort } }` and `{ reasoning: { max_tokens } }` are
 * forwarded verbatim into the request body.
 */
export const openrouterAdapter: ReasoningTransportAdapter = {
  compileEffort(effort) {
    return { reasoning: { effort } }
  },
  compileBudget(tokens) {
    return { reasoning: { max_tokens: tokens } }
  },
}
