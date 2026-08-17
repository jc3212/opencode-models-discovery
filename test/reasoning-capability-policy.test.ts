import { describe, it, expect, beforeEach } from 'vitest'
import { applyReasoningEnrichment } from '../src/reasoning/enricher'
import { registryTestUtils } from '../src/reasoning/registry/loader'
import { REGISTRY_SCHEMA_VERSION } from '../src/reasoning/registry/types'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import { mergeModelOverride } from '../src/plugin/provider-model-store'
import type { ProviderDiscoveryConfig } from '../src/types/plugin-config'
import type { ReasoningRegistry } from '../src/reasoning/registry/types'

/**
 * Capability policy + runtime integration (design §21-24, §71-75).
 */

const registry: ReasoningRegistry = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  registryVersion: '2026.08.16.1',
  models: [
    {
      model: 'openai/gpt-5.4',
      aliases: ['gpt-5.4'],
      reasoning: true,
      controls: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' }],
      sources: [{ type: 'official-doc', vendor: 'openai', verifiedAt: '2026-08-16' }],
      updatedAt: '2026-08-16',
      schemaVersion: REGISTRY_SCHEMA_VERSION,
    },
  ],
}

function makeConfig(overrides: Partial<ProviderDiscoveryConfig> = {}): ProviderDiscoveryConfig {
  return {
    reasoning: { enabled: true, transport: 'openai-compatible-effort', ...(overrides.reasoning ?? {}) },
    ...overrides,
  }
}

function run(modelId: string, opts: { policy?: 'strict' | 'official-model'; baseURL?: string; aliases?: Record<string, string> } = {}): Record<string, unknown> {
  const modelConfig: Record<string, unknown> = { id: modelId }
  applyReasoningEnrichment({
    modelConfig,
    modelId,
    providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: opts.baseURL ?? 'https://gw.example.com/v1' } },
    discoveryConfig: makeConfig({ reasoning: { enabled: true, transport: 'openai-compatible-effort', capabilityPolicy: opts.policy, aliases: opts.aliases } }),
    modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
    registry,
    providerMetadata: {},
  })
  return modelConfig
}

describe('capability policy (design §21-24, §74)', () => {
  beforeEach(() => {
    registryTestUtils.setBundledRegistry(registry)
  })

  it('strict (default) does NOT use the official registry for an anonymous relay', () => {
    const modelConfig = run('gpt-5.4', { policy: 'strict' })
    expect(modelConfig.reasoning).toBeUndefined()
    expect(modelConfig.variants).toBeUndefined()
  })

  it('official-model uses the registry when transport is known', () => {
    const modelConfig = run('gpt-5.4', { policy: 'official-model' })
    expect(modelConfig.reasoning).toBe(true)
    expect(modelConfig.variants).toEqual({
      none: { reasoningEffort: 'none' },
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      xhigh: { reasoningEffort: 'xhigh' },
    })
  })
})

describe('relay limits and user precedence (design §71-72)', () => {
  it('provider-native metadata limits the official registry (relay wins)', () => {
    const modelConfig: Record<string, unknown> = { id: 'gpt-5.4' }
    applyReasoningEnrichment({
      modelConfig,
      modelId: 'gpt-5.4',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
      discoveryConfig: makeConfig({ reasoning: { enabled: true, transport: 'openai-compatible-effort', capabilityPolicy: 'official-model' } }),
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
      registry,
      providerMetadata: { id: 'gpt-5.4', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
    })
    expect(modelConfig.variants).toEqual({
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'high' },
    })
  })

  it('user explicit variants win after the caller merge (design §72)', () => {
    // The enricher produces automatic variants; enhance-config then applies
    // mergeModelOverride so explicit user variants replace automatic ones per
    // variant id. Simulate the caller merge exactly.
    const modelConfig: Record<string, unknown> = { id: 'gpt-5.4' }
    applyReasoningEnrichment({
      modelConfig,
      modelId: 'gpt-5.4',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
      discoveryConfig: makeConfig({ reasoning: { enabled: true, transport: 'openai-compatible-effort', capabilityPolicy: 'official-model' } }),
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
      registry,
      providerMetadata: {},
    })
    const automatic = modelConfig.variants as Record<string, unknown>
    expect(automatic).toHaveProperty('high')

    // User explicit high overrides the automatic high; user turbo is added.
    const userExplicit = { high: { reasoningEffort: 'max' }, turbo: { custom: true } }
    const merged = mergeModelOverride(automatic, userExplicit)
    expect(merged.high).toEqual({ reasoningEffort: 'max' })
    expect(merged).toHaveProperty('turbo')
    expect(merged).toHaveProperty('low')
  })
})

describe('compatible transport inference', () => {
  it('official-model effort controls infer compatible variants as unverified', () => {
    const modelConfig: Record<string, unknown> = { id: 'gpt-5.4' }
    const result = applyReasoningEnrichment({
      modelConfig,
      modelId: 'gpt-5.4',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
      discoveryConfig: makeConfig({ reasoning: { enabled: true, transport: 'auto', capabilityPolicy: 'official-model' } }),
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
      registry,
      providerMetadata: {},
    })
    expect(modelConfig.reasoning).toBe(true)
    expect(modelConfig.variants).toEqual({
      none: { reasoningEffort: 'none' },
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      xhigh: { reasoningEffort: 'xhigh' },
    })
    expect(result.resolution?.transport).toMatchObject({
      transport: 'openai-compatible-effort',
      confidence: 'medium',
      reason: 'official-model-openai-compatible-effort-inferred',
      safeToCompile: true,
    })
  })
})

describe('user alias + registry (design §75, §39)', () => {
  it('a user alias maps a custom name to an official model', () => {
    const modelConfig = run('my-gpt', {
      policy: 'official-model',
      aliases: { 'my-gpt': 'openai/gpt-5.4' },
    })
    expect(modelConfig.variants).toHaveProperty('high')
    expect(modelConfig.variants).toHaveProperty('low')
  })
})
