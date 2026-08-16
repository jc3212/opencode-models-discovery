import type { ReasoningTransportAdapter } from '../types'

/**
 * Official first-party OpenAI transport (Responses API).
 *
 * Empirically verified against @ai-sdk/openai (Responses API):
 * the `reasoningEffort` model option is forwarded as a nested
 * `reasoning: { effort, summary }` object on the wire (NOT the top-level
 * `reasoning_effort` used by openai-compatible relays). The SDK adds
 * `summary: "detailed"` for non-none efforts and only sends reasoning for
 * models it recognizes as reasoning models (or when forceReasoning is set).
 *
 * Verified wire shapes:
 *   low/medium/high/xhigh/max -> { effort: <tier>, summary: "detailed" }
 *   none                       -> { effort: "none" }
 */
export const openaiAdapter: ReasoningTransportAdapter = {
  compileEffort(effort) {
    return { reasoningEffort: effort }
  },
}
