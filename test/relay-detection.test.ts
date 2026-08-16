import { describe, it, expect } from 'vitest'
import { detectRelayKind, isRelayDetectionUsable } from '../src/reasoning/relay/detection'
import { resolveRouteEvidence, resolveIngressSurface } from '../src/reasoning/relay/route-evidence'
import { normalizeProviderNativeReasoningMetadata } from '../src/utils/model-info/provider-native-reasoning'

describe('relay detection', () => {
  it('detects new-api from provider id with high confidence', () => {
    const d = detectRelayKind({ providerId: 'newapi', modelId: 'x' })
    expect(d.kind).toBe('new-api')
    expect(d.confidence).toBe('high')
    expect(d.dynamic).toBe(true)
    expect(isRelayDetectionUsable(d)).toBe(true)
  })

  it('detects sub2api from provider id', () => {
    const d = detectRelayKind({ providerId: 'sub2api', modelId: 'x' })
    expect(d.kind).toBe('sub2api')
    expect(d.confidence).toBe('high')
  })

  it('honors explicit relay config as exact', () => {
    expect(detectRelayKind({ relayConfig: 'new-api', modelId: 'x' }).confidence).toBe('exact')
    expect(detectRelayKind({ relayConfig: 'sub2api', modelId: 'x' }).confidence).toBe('exact')
    expect(detectRelayKind({ relayConfig: 'none', modelId: 'x' }).kind).toBe('direct')
  })

  it('keeps unknown relays without confidence', () => {
    const d = detectRelayKind({ providerId: 'my-gateway', modelId: 'x' })
    expect(d.kind).toBe('unknown-relay')
    expect(d.confidence).toBe('none')
    expect(isRelayDetectionUsable(d)).toBe(false)
  })
})

describe('route evidence', () => {
  const newApiDetection = { kind: 'new-api' as const, confidence: 'high' as const, evidence: [], dynamic: true }

  it('reads New API owned_by as preferred host (dynamic)', () => {
    const evidence = resolveRouteEvidence(newApiDetection, {
      modelId: 'gpt-test',
      rawModel: { owned_by: 'openrouter', supported_endpoint_types: ['chat'] },
    })
    expect(evidence.preferredHost).toBe('openrouter')
    expect(evidence.possibleHosts).toContain('openrouter')
    expect(evidence.dynamic).toBe(true)
    expect(evidence.source).toBe('new-api-owned-by')
  })

  it('reads supported_endpoint_types as evidence signals', () => {
    const evidence = resolveRouteEvidence(newApiDetection, {
      modelId: 'gpt-test',
      rawModel: { owned_by: 'openai', supported_endpoint_types: ['chat', 'responses'] },
    })
    expect(evidence.preferredHost).toBe('openai')
    expect(evidence.possibleHosts).toContain('openai')
    // supported_endpoint_types is captured structurally by discovery; here it
    // only affects the preferred host when owned_by is present.
  })

  it('owns_by is evidence, not a guarantee (dynamic stays true)', () => {
    const evidence = resolveRouteEvidence(newApiDetection, {
      modelId: 'gpt-test',
      rawModel: { owned_by: 'openai' },
    })
    expect(evidence.preferredHost).toBe('openai')
    expect(evidence.dynamic).toBe(true)
  })
})

describe('ingress surface', () => {
  it('maps npm packages to surfaces', () => {
    expect(resolveIngressSurface({ kind: 'direct', confidence: 'exact', evidence: [], dynamic: false }, { npm: '@ai-sdk/openai' })).toBe('openai-responses')
    expect(resolveIngressSurface({ kind: 'direct', confidence: 'exact', evidence: [], dynamic: false }, { npm: '@ai-sdk/anthropic' })).toBe('anthropic-messages')
    expect(resolveIngressSurface({ kind: 'direct', confidence: 'exact', evidence: [], dynamic: false }, { npm: '@ai-sdk/openai-compatible' })).toBe('openai-chat')
  })

  it('maps detected relays to relay ingress', () => {
    expect(resolveIngressSurface({ kind: 'new-api', confidence: 'high', evidence: [], dynamic: true }, { npm: '@ai-sdk/openai-compatible' })).toBe('newapi-openai')
    expect(resolveIngressSurface({ kind: 'sub2api', confidence: 'high', evidence: [], dynamic: true }, { npm: '@ai-sdk/openai-compatible' })).toBe('sub2api-openai')
  })
})

describe('Sub2API Grok provider-native metadata (design §18)', () => {
  it('parses supportsReasoningEffort + reasoningEfforts array', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      supportsReasoningEffort: true,
      reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
    })
    expect(result?.options).toEqual([{ type: 'effort', values: ['low', 'medium', 'high'] }])
    expect(result?.source).toBe('provider-native')
  })

  it('parses supportsReasoningEffort + reasoningEffort string', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      supportsReasoningEffort: true,
      reasoningEffort: 'high',
    })
    expect(result?.options).toEqual([{ type: 'effort', values: ['high'] }])
  })

  it('ignores supportsReasoningEffort=false', () => {
    const result = normalizeProviderNativeReasoningMetadata({
      supportsReasoningEffort: false,
      reasoningEfforts: [{ value: 'low' }],
    })
    expect(result).toBeUndefined()
  })
})
