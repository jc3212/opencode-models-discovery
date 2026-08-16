import type { ReasoningTransportAdapter } from '../types'

/**
 * OpenAI-compatible effort transport.
 *
 * Empirically verified against `@ai-sdk/openai-compatible`:
 * the AI SDK maps the `reasoningEffort` model option to the wire field
 * `reasoning_effort`. Toggle/budget are NOT compiled here because the
 * generic OpenAI-compatible chat body has no standard toggle/budget shape;
 * unknown fields would pass through but are not metadata-safe.
 */
export const openaiCompatibleEffortAdapter: ReasoningTransportAdapter = {
  compileEffort(effort) {
    return { reasoningEffort: effort }
  },
}
