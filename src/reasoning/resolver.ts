import type {
  CanonicalModelResolution,
  ReasoningCapability,
  ReasoningOption,
  ReasoningCapabilitySource,
  ReasoningCapabilityConfidence,
} from './types'
import type { ModelsDevModel } from '../utils/models-dev-fetcher'

/**
 * Resolves what reasoning controls the host API exposes, combining evidence
 * from provider-native metadata and models.dev metadata.
 *
 * This resolver may parse metadata but must never call a model, probe an
 * endpoint, or guess capabilities from a model name. When no trustworthy
 * metadata exists, the capability has `reasoning: true` with zero options,
 * which yields no automatic variants.
 */

export interface ReasoningCapabilityInput {
  canonical?: CanonicalModelResolution
  modelsDevModel?: ModelsDevModel
  providerNative?: unknown
}

const NONE_CAPABILITY: ReasoningCapability = {
  reasoning: false,
  options: [],
  source: 'none',
  confidence: 'none',
}

function pickOptions(canonical: CanonicalModelResolution | undefined, options: ReasoningOption[], source: ReasoningCapabilitySource): { options: ReasoningOption[]; confidence: ReasoningCapabilityConfidence } {
  if (options.length === 0) {
    return { options: [], confidence: 'none' }
  }
  const hasEffort = options.some((o) => o.type === 'effort')
  const hasToggle = options.some((o) => o.type === 'toggle')
  const hasBudget = options.some((o) => o.type === 'budget_tokens')

  let confidence: ReasoningCapabilityConfidence = 'high'
  if (canonical?.confidence === 'exact') confidence = 'exact'
  else if (canonical?.confidence === 'high') confidence = 'high'
  else if (canonical?.confidence === 'medium') confidence = 'medium'
  else if (canonical?.confidence === 'none') confidence = 'low'

  if (source === 'user') {
    confidence = 'exact'
  }

  return { options, confidence }
}

/**
 * Extracts normalized reasoning options from a provider's own metadata.
 * Currently recognized: a `reasoning_options` array (same shape as
 * models.dev), or an `options.reasoning` boolean with supported effort
 * flags. Conservative: anything unfamiliar is ignored.
 */
function providerNativeOptions(providerNative: unknown): ReasoningOption[] | undefined {
  if (!providerNative || typeof providerNative !== 'object') {
    return undefined
  }
  const raw = providerNative as Record<string, unknown>
  if (Array.isArray(raw.reasoning_options)) {
    return raw.reasoning_options as ReasoningOption[]
  }
  return undefined
}

export function resolveReasoningCapability(input: ReasoningCapabilityInput): ReasoningCapability {
  const { canonical, modelsDevModel } = input

  // 1. Provider-native metadata is authoritative for "what this host can do".
  const nativeRaw = providerNativeOptions(input.providerNative)
  if (nativeRaw) {
    const options = nativeRaw.filter(isValidOption)
    return {
      reasoning: true,
      options,
      source: 'provider-native',
      confidence: options.length > 0 ? 'exact' : 'none',
      canonicalModelId: canonical?.canonicalModelId,
      evidence: [{ source: 'provider-native', confidence: 'exact', detail: 'inline reasoning_options from provider /v1/models' }],
    }
  }

  // 2. models.dev metadata.
  if (modelsDevModel) {
    if (modelsDevModel.reasoning !== true && modelsDevModel.reasoning_options?.length) {
      return NONE_CAPABILITY
    }
    if (modelsDevModel.reasoning !== true) {
      return NONE_CAPABILITY
    }
    const options = modelsDevModel.reasoning_options ?? []
    const picked = pickOptions(canonical, options, 'models.dev')
    return {
      reasoning: true,
      options: picked.options,
      source: 'models.dev',
      confidence: picked.confidence,
      canonicalModelId: canonical?.canonicalModelId,
      evidence: [{ source: 'models.dev', confidence: picked.confidence === 'exact' ? 'exact' : picked.confidence === 'high' ? 'high' : 'medium', detail: `canonical ${canonical?.canonicalModelId ?? 'unknown'} from models.dev` }],
    }
  }

  // 3. Canonical identity known but no reasoning metadata -> unresolved.
  if (canonical?.canonicalModelId && canonical.confidence !== 'none') {
    return {
      reasoning: true,
      options: [],
      source: 'none',
      confidence: 'none',
      canonicalModelId: canonical.canonicalModelId,
    }
  }

  return NONE_CAPABILITY
}

function isValidOption(option: ReasoningOption): boolean {
  if (option.type === 'effort') {
    return Array.isArray(option.values) && option.values.length > 0
  }
  if (option.type === 'toggle') {
    return true
  }
  if (option.type === 'budget_tokens') {
    return typeof option.max === 'number' || typeof option.min === 'number'
  }
  return false
}
