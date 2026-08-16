import { describe, it, expect } from 'vitest'
import { resolveCanonicalModel } from '../src/reasoning/canonical-model'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

describe('canonical resolver: identical reasoning controls across hosts (design §17)', () => {
  it('resolves when multiple hosts expose identical non-empty reasoning_options', () => {
    const index = modelsDevTestUtils.parseModelsDevData({
      'provider-a': {
        models: {
          'doubao-seed-2.0-mini': {
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }],
          },
        },
      },
      'provider-b': {
        models: {
          'doubao-seed-2.0-mini': {
            reasoning: true,
            reasoning_options: [{ type: 'toggle' }],
          },
        },
      },
    })
    const result = resolveCanonicalModel({ modelId: 'doubao-seed-2.0-mini', modelsDevIndex: index })
    expect(result.canonicalModelId).toBeDefined()
    expect(result.confidence).toBe('medium')
    expect(result.ambiguous).toBe(true)
  })

  it('still rejects when hosts expose DIFFERENT reasoning_options', () => {
    const index = modelsDevTestUtils.parseModelsDevData({
      'provider-a': {
        models: {
          'model-x': { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
        },
      },
      'provider-b': {
        models: {
          'model-x': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        },
      },
    })
    const result = resolveCanonicalModel({ modelId: 'model-x', modelsDevIndex: index })
    expect(result.canonicalModelId).toBeUndefined()
    expect(result.confidence).toBe('none')
  })

  it('still rejects when hosts differ only in reasoning_options presence', () => {
    const index = modelsDevTestUtils.parseModelsDevData({
      'provider-a': {
        models: {
          'gpt-5': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        },
      },
      'provider-b': {
        models: {
          'gpt-5': { reasoning: true },
        },
      },
    })
    const result = resolveCanonicalModel({ modelId: 'gpt-5', modelsDevIndex: index })
    expect(result.canonicalModelId).toBeUndefined()
  })

  it('never applies the identical-controls rule to a single host', () => {
    const index = modelsDevTestUtils.parseModelsDevData({
      'provider-a': {
        models: {
          'model-y': { reasoning: true, reasoning_options: [{ type: 'toggle' }] },
        },
      },
    })
    const result = resolveCanonicalModel({ modelId: 'model-y', modelsDevIndex: index })
    expect(result.confidence).toBe('high')
    expect(result.ambiguous).toBeUndefined()
  })
})
