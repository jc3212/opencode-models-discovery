import { describe, it, expect } from 'vitest'
import { ModelInfoFormat } from '../src/types/plugin-config'
import { createModelInfoEnricher } from '../src/utils/model-info'

describe('Bifrost model info enricher', () => {
  it('extracts documented inline metadata from a raw model', () => {
    const enricher = createModelInfoEnricher(ModelInfoFormat.Bifrost, null)
    expect(enricher).toBeDefined()

    const modelConfig: any = { id: 'bedrock/anthropic.claude-sonnet-4-6' }
    const rawModel: Record<string, unknown> = {
      id: 'bedrock/anthropic.claude-sonnet-4-6',
      context_length: 200000,
      max_input_tokens: 200000,
      max_output_tokens: 8192,
      normalized_name: 'Claude Sonnet 4.6',
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      pricing: {
        prompt: '0.000003',
        completion: '0.000015',
      },
    }

    expect(enricher!.getModelName?.(modelConfig.id, rawModel)).toBe('Claude Sonnet 4.6')
    enricher!.applyModelInfo(modelConfig, modelConfig.id, rawModel)

    expect(modelConfig).toMatchObject({
      limit: { context: 200000, input: 200000, output: 8192 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      cost: { input: 0.000003, output: 0.000015 },
    })
  })

  it('leaves missing or malformed metadata unset', () => {
    const enricher = createModelInfoEnricher(ModelInfoFormat.Bifrost, null)
    const modelConfig: any = { id: 'openai/gpt-4o' }

    enricher!.applyModelInfo(modelConfig, modelConfig.id, {
      id: modelConfig.id,
      context_length: 0,
      max_input_tokens: '128000',
      max_output_tokens: -1,
      architecture: { input_modalities: ['text', 1, ''], output_modalities: [] },
      pricing: { prompt: 'invalid', completion: -1 },
    })

    expect(modelConfig).toEqual({
      id: 'openai/gpt-4o',
      modalities: { input: ['text'] },
    })
    expect(modelConfig.limit).toBeUndefined()
    expect(modelConfig.cost).toBeUndefined()
  })

  it('preserves a reported zero price', () => {
    const enricher = createModelInfoEnricher(ModelInfoFormat.Bifrost, null)
    const modelConfig: any = { id: 'local/free-model' }

    enricher!.applyModelInfo(modelConfig, modelConfig.id, {
      id: modelConfig.id,
      pricing: { prompt: '0', completion: '0.000001' },
    })

    expect(modelConfig.cost).toEqual({ input: 0, output: 0.000001 })
  })
})
