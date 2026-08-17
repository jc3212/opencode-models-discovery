import { describe, it, expect } from 'vitest'
import {
  computeReasoningFingerprint,
  computeRelayDigest,
  computeMetadataSignature,
  hashString,
} from '../src/reasoning/cache-fingerprint'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

describe('reasoning fingerprint', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'openai-compatible-effort' },
      modelInfoFormat: 'models.dev',
      metadataSignature: 'abc',
    })
    const b = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'openai-compatible-effort' },
      modelInfoFormat: 'models.dev',
      metadataSignature: 'abc',
    })
    expect(a).toBe(b)
    expect(a).toBeTypeOf('string')
  })

  it('includes the reasoning resolution algorithm version', () => {
    const current = computeReasoningFingerprint({ reasoningConfig: { enabled: true } })
    const legacy = hashString(JSON.stringify({
      enabled: true,
      transport: 'auto',
      aliases: undefined,
      modelInfoFormat: null,
      metadataSignature: null,
      relayDigest: null,
      registryVersion: null,
    }))
    expect(current).not.toBe(legacy)
  })

  it('changes when the transport changes', () => {
    const effort = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'openai-compatible-effort' },
      metadataSignature: 'abc',
    })
    const auto = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'auto' },
      metadataSignature: 'abc',
    })
    expect(effort).not.toBe(auto)
  })

  it('returns undefined when reasoning is disabled', () => {
    const fp = computeReasoningFingerprint({
      reasoningConfig: { enabled: false },
      metadataSignature: 'abc',
    })
    expect(fp).toBeUndefined()
  })

  it('changes when aliases change', () => {
    const a = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, aliases: { 'vip-a': 'openai/model-a' } },
    })
    const b = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, aliases: { 'vip-a': 'openai/model-b' } },
    })
    expect(a).not.toBe(b)
  })

  it('changes when the metadata signature changes', () => {
    const a = computeReasoningFingerprint({ reasoningConfig: { enabled: true }, metadataSignature: 'sig-1' })
    const b = computeReasoningFingerprint({ reasoningConfig: { enabled: true }, metadataSignature: 'sig-2' })
    expect(a).not.toBe(b)
  })

  it('is order-independent for aliases', () => {
    const a = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, aliases: { 'x': 'm1', 'y': 'm2' } },
    })
    const b = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, aliases: { 'y': 'm2', 'x': 'm1' } },
    })
    expect(a).toBe(b)
  })
})

describe('metadata signature', () => {
  it('changes when reasoning_options change', () => {
    const dataA = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-test': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const dataB = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-test': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
    })
    expect(computeMetadataSignature(dataA)).not.toBe(computeMetadataSignature(dataB))
  })

  it('is deterministic', () => {
    const data = modelsDevTestUtils.parseModelsDevData({
      openai: { models: { 'gpt-test': { reasoning: true } } },
    })
    expect(computeMetadataSignature(data)).toBe(computeMetadataSignature(data))
  })

  it('hashes strings deterministically', () => {
    expect(hashString('a')).toBe(hashString('a'))
    expect(hashString('a')).not.toBe(hashString('b'))
  })
})

describe('relay digest fingerprinting (design §50)', () => {
  it('changes when the relay preferred host changes', () => {
    const openrouter = computeRelayDigest(
      { kind: 'new-api', dynamic: true },
      { preferredHost: 'openrouter', possibleHosts: ['openrouter', 'openai'] },
    )
    const openai = computeRelayDigest(
      { kind: 'new-api', dynamic: true },
      { preferredHost: 'openai', possibleHosts: ['openai', 'openrouter'] },
    )
    expect(openrouter).not.toBe(openai)
  })

  it('is deterministic and order-independent for possibleHosts', () => {
    const a = computeRelayDigest({ kind: 'new-api', dynamic: true }, { preferredHost: 'openai', possibleHosts: ['openai', 'openrouter', 'anthropic'] })
    const b = computeRelayDigest({ kind: 'new-api', dynamic: true }, { preferredHost: 'openai', possibleHosts: ['anthropic', 'openrouter', 'openai'] })
    expect(a).toBe(b)
  })

  it('changes the reasoning fingerprint when relay digest changes', () => {
    const fpA = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'auto' },
      relayDigest: 'digest-A',
    })
    const fpB = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'auto' },
      relayDigest: 'digest-B',
    })
    expect(fpA).not.toBe(fpB)
  })

  it('changes when the official registry version changes (design §37)', () => {
    const fpA = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'auto' },
      registryVersion: '2026.08.16.1',
    })
    const fpB = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'auto' },
      registryVersion: '2026.08.17.1',
    })
    expect(fpA).not.toBe(fpB)
  })
})
