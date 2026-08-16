import type { ReasoningTransportAdapter } from '../types'

/**
 * DashScope Chat (Qwen thinking interface) transport.
 *
 * Empirically verified against `@ai-sdk/openai-compatible` pointed at a
 * DashScope-style OpenAI-compatible endpoint: the snake_case fields
 * `enable_thinking` and `thinking_budget` pass through verbatim into the
 * request body, producing exactly:
 *   { "enable_thinking": true, "thinking_budget": 16000 }
 *
 * Note: `@ai-sdk/alibaba` maps camelCase `enableThinking`/`thinkingBudget`
 * to the same wire fields, but it silently drops snake_case keys; the
 * dashscope-chat transport targets OpenAI-compatible surface semantics.
 */
export const dashscopeAdapter: ReasoningTransportAdapter = {
  compileToggle(enabled) {
    return { enable_thinking: enabled }
  },
  compileBudget(tokens) {
    return { enable_thinking: true, thinking_budget: tokens }
  },
}
