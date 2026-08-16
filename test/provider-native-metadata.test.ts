import { describe, it, expect } from 'vitest'
import { normalizeProviderNativeReasoningMetadata } from '../src/utils/model-info/provider-native-reasoning'
import { normalizeReasoningOptions } from '../src/utils/model-info/reasoning-options'

describe('provider-native reasoning metadata normalization', () => {
  it('parses reasoning_options array shape', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    })
    expect(result).toEqual({
      reasoning: true,
      options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      source: 'provider-native',
    })
  })

  it('parses LiteLLM model_info style with per-tier flags', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      supports_reasoning: true,
      supported_openai_params: ['reasoning_effort'],
      supports_none_reasoning_effort: true,
      supports_low_reasoning_effort: true,
      supports_high_reasoning_effort: true,
      supports_max_reasoning_effort: true,
    })
    expect(result?.options).toEqual([
      { type: 'effort', values: ['none', 'low', 'high', 'max'] },
    ])
  })

  it('falls back to medium/high when effort is supported without tier flags', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      supports_reasoning: true,
      supported_openai_params: ['reasoning_effort'],
    })
    expect(result?.options).toEqual([{ type: 'effort', values: ['medium', 'high'] }])
  })

  it('returns undefined when supports_reasoning is false', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      supports_reasoning: false,
      supported_openai_params: ['reasoning_effort'],
    })
    expect(result).toBeUndefined()
  })

  it('parses LM Studio inventory style allowed_options', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      capabilities: {
        reasoning: {
          allowed_options: ['none', 'low', 'high'],
        },
      },
    })
    expect(result?.options).toEqual([{ type: 'effort', values: ['none', 'low', 'high'] }])
  })

  it('parses generic reasoning_effort array', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      reasoning_effort: ['low', 'medium', 'high'],
    })
    expect(result?.options).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
  })

  it('parses generic thinking_options array', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      thinking_options: ['high', 'max'],
    })
    expect(result?.options).toEqual([{ type: 'effort', values: ['high', 'max'] }])
  })

  it('ignores unknown field shapes without guessing', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      some_unknown_field: true,
      model: 'gpt-x',
    })
    expect(result).toBeUndefined()
  })

  it('tolerates non-object input', () => {
    expect(normalizeProviderNativeReasoningMetadata(null)).toBeUndefined()
    expect(normalizeProviderNativeReasoningMetadata('garbage')).toBeUndefined()
    expect(normalizeProviderNativeReasoningMetadata([1, 2])).toBeUndefined()
  })

  it('normalizes reasoning_options through the shared normalizer', () => {
    expect(normalizeReasoningOptions([{ type: 'toggle' }])).toEqual([{ type: 'toggle' }])
    expect(normalizeReasoningOptions([{ type: 'effort', values: ['low', 'high'] }])).toEqual([
      { type: 'effort', values: ['low', 'high'] },
    ])
  })
})
