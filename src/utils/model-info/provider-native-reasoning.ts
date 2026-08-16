import type { ReasoningOption } from '../../reasoning/types'
import type { ReasoningMetadata } from './types'
import { normalizeReasoningOptions } from './reasoning-options'

/**
 * Provider-native reasoning metadata normalization (design §17-20).
 *
 * Providers expose reasoning capability in many field shapes. This module
 * recognizes documented/official field names only - it never guesses field
 * names. Each shape is converted to the unified ReasoningMetadata (and from
 * there to a ReasoningCapability). Unknown or malformed shapes are ignored.
 *
 * Recognized shapes:
 *   - `reasoning_options` array (models.dev-compatible, also used inline)
 *   - LiteLLM model_info style: `supports_reasoning` +
 *     `supports_<tier>_reasoning_effort` flags + `supported_openai_params`
 *   - LM Studio inventory style: `capabilities.reasoning.allowed_options`
 *   - generic `reasoning_effort` / `thinking_options` string arrays
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const EFFORT_TIERS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return strings.length > 0 ? strings : undefined
}

/** LiteLLM model_info style. */
function normalizeLiteLLMStyle(raw: Record<string, unknown>): ReasoningMetadata | undefined {
  if (raw.supports_reasoning !== true) return undefined

  const supportedParams = Array.isArray(raw.supported_openai_params)
    ? raw.supported_openai_params.filter((v): v is string => v === 'reasoning_effort')
    : []

  const values: string[] = []
  for (const tier of EFFORT_TIERS) {
    const key = `supports_${tier}_reasoning_effort`
    if (raw[key] === true) {
      values.push(tier)
    }
  }

  // If the provider explicitly supports reasoning_effort but does not list
  // per-tier flags, emit the conventional medium/high set only when effort is
  // in supported_openai_params (mirrors the existing LiteLLM enricher).
  if (values.length === 0 && supportedParams.length > 0) {
    values.push('medium', 'high')
  }

  const options: ReasoningOption[] = values.length > 0
    ? [{ type: 'effort', values }]
    : []

  return {
    reasoning: true,
    options,
    source: 'provider-native',
  }
}

/** LM Studio inventory style: capabilities.reasoning.allowed_options. */
function normalizeLMStudioStyle(raw: Record<string, unknown>): ReasoningMetadata | undefined {
  const capabilities = isObject(raw.capabilities) ? raw.capabilities : undefined
  const reasoning = capabilities ? (isObject(capabilities.reasoning) ? capabilities.reasoning : undefined) : undefined
  if (!reasoning) return undefined

  const allowed = pickStringArray(reasoning.allowed_options)
  if (!allowed) return undefined

  return {
    reasoning: true,
    options: [{ type: 'effort', values: allowed }],
    source: 'provider-native',
  }
}

/** Generic `reasoning_effort` / `thinking_options` string arrays. */
function normalizeGenericEffortStyle(raw: Record<string, unknown>): ReasoningMetadata | undefined {
  const values = pickStringArray(raw.reasoning_effort) ?? pickStringArray(raw.thinking_options)
  if (!values) return undefined

  return {
    reasoning: true,
    options: [{ type: 'effort', values }],
    source: 'provider-native',
  }
}

/**
 * Normalizes an arbitrary provider-native metadata object into
 * ReasoningMetadata, or `undefined` when nothing recognizable is present.
 */
export function normalizeProviderNativeReasoningMetadata(value: unknown): ReasoningMetadata | undefined {
  if (!isObject(value)) return undefined

  // 1. models.dev-compatible reasoning_options array (authoritative shape).
  if (Array.isArray(value.reasoning_options)) {
    const options = normalizeReasoningOptions(value.reasoning_options)
    return {
      reasoning: true,
      options,
      source: 'provider-native',
    }
  }

  // 2. LiteLLM model_info style.
  const litellm = normalizeLiteLLMStyle(value)
  if (litellm) return litellm

  // 3. LM Studio inventory style.
  const lmstudio = normalizeLMStudioStyle(value)
  if (lmstudio) return lmstudio

  // 4. Generic effort arrays.
  return normalizeGenericEffortStyle(value)
}
