import { describe, it, expect, beforeEach } from 'vitest'
import { loadRegistry, registryTestUtils } from '../src/reasoning/registry/loader'
import { applyReasoningEnrichment } from '../src/reasoning/enricher'
import { REGISTRY_SCHEMA_VERSION } from '../src/reasoning/registry/types'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import type { ReasoningRegistry } from '../src/reasoning/registry/types'

/**
 * Clean-install behavior cases (design §8-11) tested at the unit level.
 * Case A: official registry model -> variants under official-model.
 * Case B: unknown custom model -> no variants, no crash.
 * Case C: registry missing -> fail-open, discovery continues.
 * Case D: registry corrupt -> fail-open, registry disabled.
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

function runWithRegistry(modelId: string, providerMetadata: Record<string, unknown>, reg: ReasoningRegistry | undefined): Record<string, unknown> {
  const modelConfig: Record<string, unknown> = { id: modelId }
  applyReasoningEnrichment({
    modelConfig,
    modelId,
    providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
    discoveryConfig: {
      reasoning: { enabled: true, transport: 'openai-compatible-effort', capabilityPolicy: 'official-model' },
    },
    modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
    registry: reg,
    providerMetadata,
  })
  return modelConfig
}

describe('clean install cases (design §8-11)', () => {
  beforeEach(() => {
    modelsDevTestUtils.resetCache()
  })

  it('Case A: official registry model produces official variants', () => {
    const modelConfig = runWithRegistry('gpt-5.4', { id: 'gpt-5.4' }, registry)
    expect(modelConfig.variants).toEqual({
      none: { reasoningEffort: 'none' },
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      xhigh: { reasoningEffort: 'xhigh' },
    })
  })

  it('Case B: unknown custom model stays without variants and does not crash', () => {
    const modelConfig = runWithRegistry('totally-custom-model', { id: 'totally-custom-model' }, registry)
    expect(modelConfig.variants).toBeUndefined()
  })

  it('Case C: registry missing -> no official variants, discovery still works', () => {
    const modelConfig = runWithRegistry('gpt-5.4', { id: 'gpt-5.4' }, undefined)
    // Without a registry and with no provider metadata, no variants.
    expect(modelConfig.variants).toBeUndefined()
  })

  it('Case D: corrupt registry is rejected and fails open', () => {
    const corrupt = loadRegistry({ schemaVersion: 999, registryVersion: 'x', models: [] })
    expect(corrupt).toBeUndefined()
    const modelConfig = runWithRegistry('gpt-5.4', { id: 'gpt-5.4' }, corrupt ?? undefined)
    expect(modelConfig.variants).toBeUndefined()
  })
})

describe('registry loader edge cases (design §10-11)', () => {
  it('missing registry yields undefined without throwing', () => {
    registryTestUtils.setBundledRegistry(undefined)
    expect(loadRegistry(undefined)).toBeUndefined()
    expect(loadRegistry(null)).toBeUndefined()
  })

  it('corrupt JSON shape is rejected', () => {
    expect(loadRegistry({ models: 'not-an-array' })).toBeUndefined()
    expect(loadRegistry('garbage')).toBeUndefined()
  })
})
