import { describe, it, expect } from 'vitest'
import { resolveRelayAware, relayShadowTestUtils } from '../src/reasoning/relay/shadow'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

function buildIndex(data: Record<string, unknown>) {
  return modelsDevTestUtils.parseModelsDevData(data)
}

describe('relay-aware shadow resolver', () => {
  it('reads New API owned_by + supported_endpoint_types as route evidence', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5.4': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } },
      openrouter: { models: { 'gpt-5.4': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'low', 'medium', 'high'] }] } } },
    })
    const result = resolveRelayAware({
      providerId: 'newapi',
      npm: '@ai-sdk/openai-compatible',
      modelId: 'gpt-5.4',
      rawModel: { id: 'gpt-5.4', owned_by: 'openrouter', supported_endpoint_types: ['chat'] },
      modelsDevIndex: index,
    })
    expect(result.relay.kind).toBe('new-api')
    expect(result.route.preferredHost).toBe('openrouter')
    expect(result.route.dynamic).toBe(true)
    // Consensus across openai + openrouter candidates.
    expect(result.consensusOptions).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
  })

  it('prefers provider-native metadata (Sub2API Grok) as exact', () => {
    const index = buildIndex({})
    const result = resolveRelayAware({
      providerId: 'sub2api',
      modelId: 'grok-4',
      rawModel: {
        id: 'grok-4',
        supportsReasoningEffort: true,
        reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
      modelsDevIndex: index,
    })
    expect(result.consensusSource).toBe('provider-native')
    expect(result.consensusOptions).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
    expect(result.identityConfidence).toBe('advertised-standard-id')
  })

  it('honors user aliases as strongest identity evidence', () => {
    const index = buildIndex({
      openai: { models: { 'gpt-5.4': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
    })
    const result = resolveRelayAware({
      providerId: 'newapi',
      modelId: 'vip-gpt',
      rawModel: { id: 'vip-gpt' },
      modelsDevIndex: index,
      aliases: { 'vip-gpt': 'openai/gpt-5.4' },
    })
    expect(result.identityConfidence).toBe('alias')
    expect(result.consensusOptions).toEqual([{ type: 'effort', values: ['low', 'high'] }])
    expect(result.safeToCompile).toBe(true)
  })

  it('yields consensus-empty when candidate controls conflict', () => {
    const index = buildIndex({
      'provider-a': { models: { 'model-x': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } },
      'provider-b': { models: { 'model-x': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['xhigh', 'max'] }] } } },
    })
    const result = resolveRelayAware({
      providerId: 'newapi',
      modelId: 'model-x',
      rawModel: { id: 'model-x', owned_by: 'provider-a' },
      modelsDevIndex: index,
    })
    // intersection of [low,medium,high] and [xhigh,max] is empty -> no variants
    expect(result.consensusOptions).toEqual([])
    expect(result.safeToCompile).toBe(false)
    expect(result.reason).toBe('consensus-empty')
  })

  it('extracts relay evidence without credentials', () => {
    const evidence = relayShadowTestUtils.extractRelayEvidence({
      id: 'x',
      owned_by: 'openrouter',
      apiKey: 'secret-123',
      Authorization: 'Bearer secret',
      reasoningEfforts: [{ value: 'high' }],
    })
    expect(evidence?.metadata.ownedBy).toBe('openrouter')
    expect(evidence?.metadata.reasoningEfforts).toEqual([{ value: 'high' }])
    expect(JSON.stringify(evidence)).not.toContain('secret')
    expect(JSON.stringify(evidence)).not.toContain('Authorization')
  })
})
