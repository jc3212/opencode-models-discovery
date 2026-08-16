/**
 * Core types for the conservative reasoning enrichment system.
 *
 * The pipeline separates three concepts that must never be conflated:
 *
 * 1. Model Identity  - which underlying model does an API model id map to?
 * 2. Reasoning Control - what does the host API metadata say we can control?
 * 3. Transport       - how should OpenCode / the AI SDK express a control
 *                      so the final HTTP request body is correct?
 *
 * Metadata is a hint. Transport is the only gate that decides whether
 * automatic variants are compiled. When transport confidence is too low,
 * variants stay empty and the model remains usable.
 */

/**
 * A single normalized reasoning control that a host API exposes.
 * Mirrors the models.dev `reasoning_options` entry shape.
 */
export type ReasoningOption =
  | {
      type: 'effort'
      values: string[]
    }
  | {
      type: 'toggle'
    }
  | {
      type: 'budget_tokens'
      min?: number
      max?: number
    }

/** Whether an option is considered safe to drive automatic variants. */
export function isUsableReasoningOption(option: ReasoningOption): boolean {
  if (option.type === 'effort') {
    return Array.isArray(option.values) && option.values.length > 0
  }
  if (option.type === 'toggle') {
    return true
  }
  return false
}

/**
 * The canonical identity of an underlying model after resolution.
 *
 * This resolution is used ONLY for metadata lookup. It never rewrites the
 * model id that is sent to the provider on the wire.
 */
export type CanonicalMatchSource =
  | 'user-alias'
  | 'exact'
  | 'namespace-stripped'
  | 'unique-model-id'
  | 'safe-revision-match'
  | 'none'

export type CanonicalConfidence = 'exact' | 'high' | 'medium' | 'none'

export interface CanonicalModelResolution {
  /** The id exactly as the provider returned it. */
  discoveredModelId: string
  /** The canonical `provider/model` id used for metadata lookup. */
  canonicalModelId?: string
  /** The canonical provider id when known. */
  canonicalProviderId?: string
  source: CanonicalMatchSource
  confidence: CanonicalConfidence
  ambiguous?: boolean
}

export type ReasoningCapabilitySource =
  | 'provider-native'
  | 'models.dev'
  | 'user'
  | 'safe-rule'
  | 'none'

export type ReasoningCapabilityConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none'

/**
 * What the metadata says the host API can control.
 *
 * `reasoning: true` with zero options means "the model reasons, but we do
 * not know how this host controls it" - which yields no automatic variants.
 */
export interface ReasoningCapability {
  reasoning: boolean
  options: ReasoningOption[]
  source: ReasoningCapabilitySource
  confidence: ReasoningCapabilityConfidence
  canonicalModelId?: string
  /** The host API that exposed these controls (when known). */
  metadataHostId?: string
  /** Evidence trail explaining WHY this capability was resolved (design §20). */
  evidence?: ReasoningEvidence[]
}

export interface ReasoningEvidence {
  source: 'provider-native' | 'models.dev' | 'verified-profile' | 'user'
  confidence: 'exact' | 'high' | 'medium'
  detail?: string
}

export type ReasoningTransportType =
  | 'openai-compatible-effort'
  | 'openrouter'
  | 'dashscope-chat'
  | 'anthropic'
  | 'google'
  | 'alibaba-sdk'
  | 'unknown'

export type TransportConfidence = 'exact' | 'high' | 'medium' | 'low' | 'none'

export interface TransportResolution {
  transport: ReasoningTransportType
  confidence: TransportConfidence
  reason: string
  /** Only the Variant Compiler is allowed to run when this is true. */
  safeToCompile: boolean
}

export interface ResolvedReasoning {
  model: CanonicalModelResolution
  capability: ReasoningCapability
  transport: TransportResolution
  variants: Record<string, Record<string, unknown>>
  warnings: string[]
  diagnostics: {
    matchReason?: string
    capabilityReason?: string
    transportReason?: string
  }
}

export interface ReasoningCompileResult {
  variants: Record<string, Record<string, unknown>>
  warnings: string[]
}

/**
 * The option shape (camelCase) that an adapter produces for a reasoning
 * control. These are AI SDK model-level options; the SDK maps them to the
 * wire body (e.g. `reasoningEffort` -> `reasoning_effort`).
 */
export interface ReasoningTransportAdapter {
  compileEffort?(effort: string): Record<string, unknown> | undefined
  compileToggle?(enabled: boolean): Record<string, unknown> | undefined
  compileBudget?(tokens: number): Record<string, unknown> | undefined
}
