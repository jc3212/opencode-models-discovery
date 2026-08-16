import { describe, it, expect, beforeEach } from 'vitest'
import { normalizeReasoningOptions } from '../src/utils/model-info/reasoning-options'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

describe('reasoning options normalization', () => {
  it('parses effort options preserving the metadata value set', () => {
    const options = normalizeReasoningOptions([
      { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ])

    expect(options).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ])
  })

  it('drops empty effort value lists', () => {
    expect(normalizeReasoningOptions([{ type: 'effort', values: [] }])).toEqual([])
    expect(normalizeReasoningOptions([{ type: 'effort', values: [1, 'x'] }])).toEqual([])
  })

  it('parses toggle options without inventing effort levels', () => {
    expect(normalizeReasoningOptions([{ type: 'toggle' }])).toEqual([{ type: 'toggle' }])
  })

  it('parses budget_tokens with only finite positive bounds', () => {
    expect(normalizeReasoningOptions([{ type: 'budget_tokens', min: 1024, max: 32768 }]))
      .toEqual([{ type: 'budget_tokens', min: 1024, max: 32768 }])
    expect(normalizeReasoningOptions([{ type: 'budget_tokens', max: 32768 }]))
      .toEqual([{ type: 'budget_tokens', max: 32768 }])
    expect(normalizeReasoningOptions([{ type: 'budget_tokens', min: 0, max: -1 }]))
      .toEqual([])
  })

  it('drops unknown or malformed option shapes', () => {
    expect(normalizeReasoningOptions([
      { type: 'unknown' },
      { type: 'effort' },
      'garbage',
      null,
      42,
      { type: 'budget_tokens', min: 'lots' },
    ])).toEqual([])
  })

  it('returns an empty list for absent or non-array values', () => {
    expect(normalizeReasoningOptions(undefined)).toEqual([])
    expect(normalizeReasoningOptions(null)).toEqual([])
    expect(normalizeReasoningOptions('not-an-array')).toEqual([])
    expect(normalizeReasoningOptions({ type: 'toggle' })).toEqual([])
  })
})

describe('models.dev reasoning_options parsing', () => {
  beforeEach(() => {
    modelsDevTestUtils.resetCache()
  })

  it('parses reasoning_options from provider-nested models.dev data', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-5': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
          },
        },
      },
    })

    expect(cache.get('openai/gpt-5')).toEqual(expect.objectContaining({
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }],
    }))
  })

  it('parses reasoning_options from flat models.dev data', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      'alibaba/qwen3-max': {
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 32768 }],
      },
    })

    expect(cache.get('alibaba/qwen3-max')?.reasoning_options).toEqual([
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ])
  })

  it('leaves reasoning_options undefined when the field is absent', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      'deepseek/deepseek-r1': { reasoning: true },
    })

    expect(cache.get('deepseek/deepseek-r1')).toEqual(expect.objectContaining({
      reasoning: true,
    }))
    expect(cache.get('deepseek/deepseek-r1')?.reasoning_options).toBeUndefined()
  })

  it('tolerates malformed reasoning_options without breaking parsing', () => {
    const cache = modelsDevTestUtils.parseModelsDevData({
      'openai/gpt-5': {
        reasoning: true,
        reasoning_options: [{ type: 'unknown' }, 'bad'],
      },
    })

    expect(cache.get('openai/gpt-5')?.reasoning_options).toEqual([])
    expect(cache.get('openai/gpt-5')?.reasoning).toBe(true)
  })

  it('loads openai-effort fixture correctly', async () => {
    const fixture = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/models-dev/openai-effort.json', import.meta.url), 'utf8'))
    const cache = modelsDevTestUtils.parseModelsDevData(fixture)
    expect(cache.get('openai/gpt-5')?.reasoning_options).toEqual([
      { type: 'effort', values: ['none', 'low', 'medium', 'high'] },
    ])
  })

  it('loads qwen-toggle-budget fixture correctly', async () => {
    const fixture = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/models-dev/qwen-toggle-budget.json', import.meta.url), 'utf8'))
    const cache = modelsDevTestUtils.parseModelsDevData(fixture)
    expect(cache.get('alibaba/qwen3-max')?.reasoning_options).toEqual([
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ])
  })
})
