import type { ReasoningTransportAdapter } from '../types'

/**
 * First-party Alibaba (DashScope) SDK transport.
 *
 * Empirically verified against `@ai-sdk/alibaba`:
 * - `enableThinking` / `thinkingBudget` (camelCase) map to the wire
 *   fields `enable_thinking` / `thinking_budget`.
 * - `reasoningEffort` is silently dropped, so effort controls are NOT
 *   compiled for this transport.
 */
export const alibabaSdkAdapter: ReasoningTransportAdapter = {
  compileToggle(enabled) {
    return { enableThinking: enabled }
  },
  compileBudget(tokens) {
    return { enableThinking: true, thinkingBudget: tokens }
  },
}
