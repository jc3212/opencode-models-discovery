import { describe, it, expect } from 'vitest'
import { modelsDevTestUtils, lookupModelsDevData } from '../src/utils/models-dev-fetcher'
import { createModelsDevModelInfoEnricher } from '../src/utils/model-info/models-dev'
import { normalizeReasoningOptions } from '../src/utils/model-info/reasoning-options'
import { resolveReasoningCapability } from '../src/reasoning/resolver'

/**
 * Task 1: trace the plugin's models.dev data chain.
 * If models.dev DID publish reasoning_options, does the plugin carry it
 * from raw JSON -> parsed cache -> lookup -> enricher -> capability?
 */
describe('models.dev reasoning_options data chain (plugin side)', () => {
  it('parse: raw reasoning_options survives parseModelsDevData into the cache', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      'alibaba/qwen3-max': {
        reasoning: true,
        reasoning_options: [
          { type: 'toggle' },
          { type: 'budget_tokens', min: 1024, max: 32768 },
        ],
      },
    })
    expect(cache.get('alibaba/qwen3-max')?.reasoning_options).toEqual([
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ])
  })

  it('lookup: lookupModelsDevData returns reasoning_options', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-5': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const info = lookupModelsDevData('openai/gpt-5', cache)
    expect(info?.reasoning_options).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
  })

  it('enricher: getReasoningMetadata surfaces reasoning_options', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-5': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const enricher = createModelsDevModelInfoEnricher(cache)
    const metadata = enricher.getReasoningMetadata?.('gpt-5')
    expect(metadata?.options).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
  })

  it('capability: reasoning_options reaches ReasoningCapability', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-5': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const info = lookupModelsDevData('openai/gpt-5', cache)
    const capability = resolveReasoningCapability({ modelsDevModel: info })
    expect(capability.options).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
    expect(capability.reasoning).toBe(true)
  })

  it('normalizer: handles the exact values models.dev would use', () => {
    // Forward-compat: a future models.dev effort list with minimal/xhigh/max
    const options = normalizeReasoningOptions([
      { type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] },
    ])
    expect(options).toEqual([{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh'] }])
  })
})
