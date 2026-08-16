import type { ReasoningTransportAdapter } from '../types'

/**
 * Anthropic transport (second-phase support).
 *
 * Maps metadata controls to `@ai-sdk/anthropic` model options, matching
 * OpenCode core's own transform:
 * - effort -> { effort }
 * - budget_tokens -> { thinking: { type: 'enabled', budgetTokens } }
 * - toggle -> { thinking: { type: 'disabled'|'enabled' } }
 */
export const anthropicAdapter: ReasoningTransportAdapter = {
  compileEffort(effort) {
    return { effort }
  },
  compileBudget(tokens) {
    return { thinking: { type: 'enabled', budgetTokens: tokens } }
  },
  compileToggle(enabled) {
    return { thinking: { type: enabled ? 'enabled' : 'disabled' } }
  },
}
