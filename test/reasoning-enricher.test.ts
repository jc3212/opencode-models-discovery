import { describe, it, expect } from 'vitest'
import { applyReasoningEnrichment } from '../src/reasoning/enricher'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import type { ProviderDiscoveryConfig } from '../src/types/plugin-config'

function buildIndex(data: Record<string, unknown>) {
  return modelsDevTestUtils.parseModelsDevData(data)
}

describe('reasoning enricher orchestration', () => {
  it('Case A: applies effort variants for openai-compatible with explicit transport', () => {
    const index = buildIndex({
      openai: {
        models: {
          'gpt-test': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const modelConfig: Record<string, unknown> = { id: 'gpt-test' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      modelInfoFormat: 'models.dev',
      reasoning: { enabled: true, transport: 'openai-compatible-effort' },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'gpt-test',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(result.applied).toBe(true)
    expect(modelConfig.variants).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    })
  })

  it('Case B: applies none/high/max for qwen through dashscope-chat', () => {
    const index = buildIndex({
      alibaba: {
        models: {
          'qwen3-max': {
            reasoning: true,
            reasoning_options: [
              { type: 'toggle' },
              { type: 'budget_tokens', min: 1024, max: 32768 },
            ],
          },
        },
      },
    })
    const modelConfig: Record<string, unknown> = { id: 'qwen3-max' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'dashscope-chat' },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'qwen3-max',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(result.applied).toBe(true)
    expect(modelConfig.variants).toEqual({
      none: { enable_thinking: false },
      high: { enable_thinking: true, thinking_budget: 16000 },
      max: { enable_thinking: true, thinking_budget: 32768 },
    })
  })

  it('Case C: unknown gateway resolves canonical but never compiles variants', () => {
    const index = buildIndex({
      alibaba: {
        models: {
          'qwen-x': {
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 32768 }],
          },
        },
      },
    })
    const modelConfig: Record<string, unknown> = { id: 'qwen-x' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'auto' },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'qwen-x',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(result.applied).toBe(true)
    expect(result.resolution?.transport).toMatchObject({ transport: 'unknown', safeToCompile: false })
    expect(modelConfig.variants).toBeUndefined()
  })

  it('does not touch the model when reasoning enrichment is disabled', () => {
    const index = buildIndex({
      openai: {
        models: {
          'gpt-test': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const modelConfig: Record<string, unknown> = { id: 'gpt-test' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: false },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'gpt-test',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    // The caller (enhance-config) skips the call entirely when disabled; the
    // enricher itself also refuses to apply when not enabled.
    expect(modelConfig.variants).toBeUndefined()
    expect(result.applied).toBe(false)
  })

  it('keeps a model usable when canonical resolution is ambiguous', () => {
    const index = buildIndex({
      'provider-a': { models: { 'model-x': { reasoning: true, reasoning_options: [{ type: 'toggle' }] } } },
      'provider-b': { models: { 'model-x': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
    })
    const modelConfig: Record<string, unknown> = { id: 'model-x' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'auto' },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'model-x',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(result.applied).toBe(true)
    expect(modelConfig.variants).toBeUndefined()
  })

  it('honors user aliases for canonical lookup', () => {
    const index = buildIndex({
      openai: {
        models: {
          'gpt-x': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
    })
    const modelConfig: Record<string, unknown> = { id: 'vip-gpt' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: {
        enabled: true,
        transport: 'openai-compatible-effort',
        aliases: { 'vip-gpt': 'openai/gpt-x' },
      },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'vip-gpt',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gateway.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(result.resolution?.model).toMatchObject({ canonicalModelId: 'openai/gpt-x', source: 'user-alias' })
    expect(modelConfig.variants).toEqual({
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'high' },
    })
  })

  it('never sets variants when metadata has reasoning without controls', () => {
    const index = buildIndex({
      deepseek: {
        models: {
          'deepseek-r1': { reasoning: true },
        },
      },
    })
    const modelConfig: Record<string, unknown> = { id: 'deepseek-r1' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'auto' },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'deepseek-r1',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.deepseek.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(modelConfig.variants).toBeUndefined()
  })
})
