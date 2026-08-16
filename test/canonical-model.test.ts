import { describe, it, expect } from 'vitest'
import { resolveCanonicalModel } from '../src/reasoning/canonical-model'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

function buildIndex(data: Record<string, unknown>) {
  return modelsDevTestUtils.parseModelsDevData(data)
}

describe('canonical model resolver', () => {
  it('resolves an exact canonical id', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'openai/gpt-5', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-5',
      source: 'exact',
      confidence: 'exact',
    })
  })

  it('resolves exact case-insensitively', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'OpenAI/GPT-5', modelsDevIndex: index })
    expect(result.canonicalModelId).toBe('openai/gpt-5')
  })

  it('resolves an alias', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({
      modelId: 'vip-gpt',
      aliases: { 'vip-gpt': 'openai/gpt-5' },
      modelsDevIndex: index,
    })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-5',
      source: 'user-alias',
      confidence: 'exact',
    })
  })

  it('honors an alias target even when absent from the index', () => {
    const index = buildIndex({})
    const result = resolveCanonicalModel({
      modelId: 'vip-gpt',
      aliases: { 'vip-gpt': 'openai/gpt-x' },
      modelsDevIndex: index,
    })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-x',
      source: 'user-alias',
      confidence: 'high',
    })
  })

  it('resolves a namespace-stripped gateway prefix', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'my-gateway/gpt-5', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-5',
      source: 'namespace-stripped',
      confidence: 'high',
    })
  })

  it('resolves a unique model id without a provider', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
      anthropic: { models: { 'claude-4-opus': { id: 'claude-4-opus' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'gpt-5', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-5',
      source: 'unique-model-id',
      confidence: 'high',
    })
  })

  it('resolves a safe revision suffix', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'gpt-5-2025-11-20', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-5',
      source: 'safe-revision-match',
      confidence: 'high',
    })
  })

  it('resolves a safe version suffix', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'gpt-5-v2', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: 'openai/gpt-5',
      source: 'safe-revision-match',
    })
  })

  it('rejects ambiguous duplicate model ids', () => {
    const index = buildIndex({
      'provider-a': { models: { 'model-x': { id: 'model-x' } } },
      'provider-b': { models: { 'model-x': { id: 'model-x' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'model-x', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: undefined,
      confidence: 'none',
      ambiguous: true,
    })
  })

  it('does not fuzzy-guess my-gpt into gpt-x', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-x': { id: 'gpt-x' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'my-gpt', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: undefined,
      source: 'none',
      confidence: 'none',
    })
  })

  it('does not treat a plain hyphen suffix as a revision', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-x': { id: 'gpt-x' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'gpt-x-turbo', modelsDevIndex: index })
    expect(result.canonicalModelId).toBeUndefined()
  })

  it('returns none for an unknown model', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5': { id: 'gpt-5' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'custom-ai-9000', modelsDevIndex: index })
    expect(result).toMatchObject({ source: 'none', confidence: 'none' })
  })

  it('strips models.dev-style tags before matching', () => {
    const index = buildIndex({
      'moonshotai': { models: { 'kimi-k2.6': { id: 'kimi-k2.6' } } },
    })
    const result = resolveCanonicalModel({ modelId: 'moonshotai/kimi-k2.6:free', modelsDevIndex: index })
    expect(result).toMatchObject({
      canonicalModelId: 'moonshotai/kimi-k2.6',
      source: 'exact',
    })
  })
})
