import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import { applyReasoningEnrichment } from '../src/reasoning/enricher'
import type { ProviderDiscoveryConfig } from '../src/types/plugin-config'

/**
 * Real-world proof: the live models.dev api.json (the rich endpoint) carries
 * reasoning_options, and the plugin's full enricher now turns them into
 * variants. This uses a fixture snapshot of the live api.json shape.
 */
describe('real models.dev api.json → variants', () => {
  it('compiles effort variants for a real reasoning model', async () => {
    const apiData = {
      'hpc-ai': {
        id: 'hpc-ai',
        name: 'HPC AI',
        models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
          },
        },
      },
    }
    const index = modelsDevTestUtils.parseModelsDevData(apiData)

    const modelConfig: Record<string, unknown> = { id: 'deepseek-v4-flash' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      modelInfoFormat: 'models.dev',
      reasoning: { enabled: true, transport: 'openai-compatible-effort' },
    }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'deepseek-v4-flash',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(result.applied).toBe(true)
    expect(modelConfig.variants).toEqual({
      high: { reasoningEffort: 'high' },
      max: { reasoningEffort: 'max' },
    })
  })

  it('resolves a real qwen model with toggle+budget from api.json', () => {
    const apiData = {
      alibaba: {
        id: 'alibaba',
        models: {
          'qwen3-max': {
            id: 'qwen3-max',
            reasoning: true,
            reasoning_options: [
              { type: 'toggle' },
              { type: 'budget_tokens', min: 1024, max: 32768 },
            ],
          },
        },
      },
    }
    const index = modelsDevTestUtils.parseModelsDevData(apiData)
    const modelConfig: Record<string, unknown> = { id: 'qwen3-max' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'dashscope-chat' },
    }
    applyReasoningEnrichment({
      modelConfig,
      modelId: 'qwen3-max',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(modelConfig.variants).toEqual({
      none: { enable_thinking: false },
      high: { enable_thinking: true, thinking_budget: 16000 },
      max: { enable_thinking: true, thinking_budget: 32768 },
    })
  })
})
