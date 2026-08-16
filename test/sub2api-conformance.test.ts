import { describe, it, expect, afterEach } from 'vitest'
import { Sub2APIConformanceHarness } from './helpers/sub2api-conformance'
import { detectRelayKind } from '../src/reasoning/relay/detection'
import { resolveRelayAware } from '../src/reasoning/relay/shadow'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

/**
 * Sub2API conformance (design §36-38, §64-66).
 *
 * Verifies plugin-side behavior against a Sub2API-style relay:
 * - bare /v1/models must NOT let the plugin assume a platform from the name
 * - Grok reasoningEfforts is exact provider-native metadata
 * - composite groups are dynamic routes, never a fixed transport
 * - channel mapping means a public id may not be the upstream id
 */

let harness: Sub2APIConformanceHarness | undefined

afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = undefined
  }
})

describe('Sub2API generic list (design §64)', () => {
  it('bare ids do not let the plugin infer platform from the model name', async () => {
    harness = await Sub2APIConformanceHarness.create({ bareList: true })
    const index = modelsDevTestUtils.parseModelsDevData({})
    const shadow = resolveRelayAware({
      providerId: 'sub2api',
      modelId: 'gpt-5.4',
      rawModel: { id: 'gpt-5.4' },
      modelsDevIndex: index,
    })
    // No owned_by / endpoint types -> relay kind not usable, no consensus.
    expect(shadow.safeToCompile).toBe(false)
    expect(shadow.reason).toMatch(/missing-candidate|consensus/)
  })
})

describe('Sub2API Grok metadata (design §65, §18)', () => {
  it('reasoningEfforts is exact provider-native metadata without models.dev', async () => {
    harness = await Sub2APIConformanceHarness.create({ grokMetadata: true })
    const index = modelsDevTestUtils.parseModelsDevData({})
    const shadow = resolveRelayAware({
      providerId: 'sub2api',
      modelId: 'grok-4',
      rawModel: {
        id: 'grok-4',
        supportsReasoningEffort: true,
        reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      },
      modelsDevIndex: index,
    })
    expect(shadow.consensusSource).toBe('provider-native')
    expect(shadow.consensusOptions).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
    expect(shadow.identityConfidence).toBe('advertised-standard-id')
  })
})

describe('Sub2API composite group (design §38)', () => {
  it('composite is treated as a dynamic route, never a fixed transport', () => {
    const detection = detectRelayKind({ providerId: 'sub2api', modelId: 'x', relayConfig: 'sub2api' })
    expect(detection.kind).toBe('sub2api')
    expect(detection.dynamic).toBe(true)
    // The plugin must not pin a provider-level transport for composite.
    // resolveIngressSurface returns sub2api-openai only as a surface, not a
    // hidden-upstream guarantee.
    const shadow = resolveRelayAware({
      providerId: 'sub2api',
      modelId: 'claude-opus-4-6',
      rawModel: { id: 'claude-opus-4-6' },
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
      relayConfig: 'sub2api',
    })
    expect(shadow.safeToCompile).toBe(false)
  })
})

describe('Sub2API channel mapping (design §66)', () => {
  it('public id may map to a different upstream; resolver must not claim exact identity', async () => {
    harness = await Sub2APIConformanceHarness.create({
      bareList: true,
      channelMapping: { 'gpt-test': 'some-other-model' },
    })
    const index = modelsDevTestUtils.parseModelsDevData({
      openai: { models: { 'some-other-model': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
    })
    const shadow = resolveRelayAware({
      providerId: 'sub2api',
      modelId: 'gpt-test',
      rawModel: { id: 'gpt-test' },
      modelsDevIndex: index,
    })
    // gpt-test is not in models.dev; some-other-model is, but we cannot know
    // the mapping, so identity must stay unknown (not exact).
    expect(shadow.identityConfidence).not.toBe('exact')
    expect(shadow.safeToCompile).toBe(false)
  })
})
