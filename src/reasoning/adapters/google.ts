import type { ReasoningTransportAdapter } from '../types'

/**
 * Google (Gemini) transport (second-phase support).
 *
 * Matches OpenCode core's transform for `@ai-sdk/google`:
 * - effort -> { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
 * - budget_tokens -> { thinkingConfig: { includeThoughts: true, thinkingBudget: tokens } }
 */
export const googleAdapter: ReasoningTransportAdapter = {
  compileEffort(effort) {
    return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
  },
  compileBudget(tokens) {
    return { thinkingConfig: { includeThoughts: true, thinkingBudget: tokens } }
  },
}
