import { describe, it, expect } from 'vitest'
import { applyReasoningEnrichment } from '../src/reasoning/enricher'
import { resolveRelayAware } from '../src/reasoning/relay/shadow'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import type { ProviderDiscoveryConfig } from '../src/types/plugin-config'

/**
 * Phase 8: safe runtime enablement policy (design §35, §76).
 *
 * Runtime (applyReasoningEnrichment) must NOT inject variants derived from
 * relay-aware consensus. Relay consensus is shadow-only until conformance +
 * coverage criteria are met. This test locks in that separation.
 */
describe('runtime enablement stays shadow-safe', () => {
  it('runtime enricher does not inject relay-consensus variants for a bare relay model', () => {
    // A relay model whose candidates have a safe consensus in models.dev.
    const index = modelsDevTestUtils.parseModelsDevData({
      openai: { models: { 'gemini-3-flash': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } },
      google: { models: { 'gemini-3-flash': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }] } } },
    })

    // Shadow says this WOULD be safe (consensus low/medium/high).
    const shadow = resolveRelayAware({
      providerId: 'openchat',
      npm: '@ai-sdk/openai-compatible',
      modelId: 'gemini-3-flash',
      rawModel: { id: 'gemini-3-flash', owned_by: 'custom', supported_endpoint_types: ['openai'] },
      modelsDevIndex: index,
    })
    expect(shadow.safeToCompile).toBe(true)
    expect(shadow.consensusOptions).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])

    // But runtime enrichment does NOT use relay consensus: no transport is
    // configured and host is unknown, so it stays without variants.
    const modelConfig: Record<string, unknown> = { id: 'gemini-3-flash' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'auto' },
    }
    applyReasoningEnrichment({
      modelConfig,
      modelId: 'gemini-3-flash',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.openclawplan.com/v1' } },
      discoveryConfig,
      modelsDevIndex: index,
    })
    expect(modelConfig.variants).toBeUndefined()
  })

  it('runtime enricher DOES inject provider-native exact metadata (Grok style)', () => {
    // Provider-native metadata is conformance-verified and already enabled.
    const modelConfig: Record<string, unknown> = { id: 'grok-4' }
    const discoveryConfig: ProviderDiscoveryConfig = {
      reasoning: { enabled: true, transport: 'openai-compatible-effort' },
    }
    applyReasoningEnrichment({
      modelConfig,
      modelId: 'grok-4',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://s2a.example.com/v1' } },
      discoveryConfig,
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
      providerMetadata: {
        id: 'grok-4',
        supportsReasoningEffort: true,
        reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
    })
    expect(modelConfig.variants).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    })
  })
})
