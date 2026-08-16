import type { ReasoningTransportAdapter, ReasoningTransportType } from '../types'
import { openaiCompatibleEffortAdapter } from './openai-compatible'
import { openaiAdapter } from './openai'
import { openrouterAdapter } from './openrouter'
import { dashscopeAdapter } from './dashscope'
import { anthropicAdapter } from './anthropic'
import { googleAdapter } from './google'
import { alibabaSdkAdapter } from './alibaba'

/**
 * Every adapter is unit tested and (for the MVP transports) integration
 * tested against a fake provider that captures the real HTTP body.
 */
const ADAPTERS: Partial<Record<ReasoningTransportType, ReasoningTransportAdapter>> = {
  'openai-compatible-effort': openaiCompatibleEffortAdapter,
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
  'dashscope-chat': dashscopeAdapter,
  anthropic: anthropicAdapter,
  google: googleAdapter,
  'alibaba-sdk': alibabaSdkAdapter,
}

export function getTransportAdapter(transport: ReasoningTransportType): ReasoningTransportAdapter | undefined {
  return ADAPTERS[transport]
}
