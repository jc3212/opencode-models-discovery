import { describe, it, expect } from 'vitest'
import { modelsDevTestUtils, lookupModelsDevData } from '../src/utils/models-dev-fetcher'
import { createModelsDevModelInfoEnricher } from '../src/utils/model-info/models-dev'
import { resolveReasoningCapability } from '../src/reasoning/resolver'

/**
 * Task 1 root cause regression: models.dev api.json (provider-scoped) is the
 * only endpoint carrying reasoning_options. The plugin must parse it and
 * carry reasoning_options through lookup -> enricher -> capability.
 */
describe('models.dev api.json reasoning_options integration', () => {
  it('parses the provider-scoped api.json shape with reasoning_options', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      'hpc-ai': {
        id: 'hpc-ai',
        env: true,
        npm: '@ai-sdk/openai-compatible',
        api: 'openai',
        name: 'HPC AI',
        doc: '...',
        models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
          },
        },
      },
    })

    expect(cache.get('hpc-ai/deepseek/deepseek-v4-flash')).toBeUndefined()
    // The model id already contains a provider prefix, so it is stored as-is.
    const entry = lookupModelsDevData('deepseek/deepseek-v4-flash', cache)
    expect(entry?.reasoning_options).toEqual([{ type: 'effort', values: ['high', 'max'] }])
  })

  it('carries real api.json reasoning_options to the capability resolver', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      'hpc-ai': {
        id: 'hpc-ai',
        models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
          },
        },
      },
    })

    const enricher = createModelsDevModelInfoEnricher(cache)
    const metadata = enricher.getReasoningMetadata?.('deepseek/deepseek-v4-flash')
    expect(metadata?.options).toEqual([{ type: 'effort', values: ['high', 'max'] }])

    const capability = resolveReasoningCapability({ modelsDevModel: metadata ? {
      id: 'deepseek/deepseek-v4-flash',
      reasoning: metadata.reasoning,
      reasoning_options: metadata.options,
    } : undefined })
    expect(capability.reasoning).toBe(true)
    expect(capability.options).toEqual([{ type: 'effort', values: ['high', 'max'] }])
  })
})
