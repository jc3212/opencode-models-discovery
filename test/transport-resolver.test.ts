import { describe, it, expect } from 'vitest'
import { resolveReasoningTransport, reasoningTransportTestUtils } from '../src/reasoning/transport'
import { normalizeExplicitTransport } from '../src/reasoning/profiles'

describe('transport resolver', () => {
  it('lets explicit transport win', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://gateway.example.com/v1',
      explicitTransport: 'openai-compatible-effort',
    })
    expect(result).toMatchObject({
      transport: 'openai-compatible-effort',
      confidence: 'exact',
      reason: 'explicit-config',
      safeToCompile: true,
    })
  })

  it('resolves explicit dashscope-chat', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      explicitTransport: 'dashscope-chat',
    })
    expect(result).toMatchObject({ transport: 'dashscope-chat', safeToCompile: true })
  })

  it('resolves the OpenRouter npm profile', () => {
    const result = resolveReasoningTransport({ npm: '@openrouter/ai-sdk-provider' })
    expect(result).toMatchObject({
      transport: 'openrouter',
      confidence: 'exact',
      reason: 'known-provider-profile',
      safeToCompile: true,
    })
  })

  it('resolves the DashScope baseURL profile', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
    expect(result).toMatchObject({ transport: 'dashscope-chat', safeToCompile: true })
  })

  it('resolves the DashScope provider id profile', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      providerId: 'dashscope',
    })
    expect(result).toMatchObject({ transport: 'dashscope-chat', safeToCompile: true })
  })

  it('resolves @ai-sdk/alibaba to alibaba-sdk', () => {
    const result = resolveReasoningTransport({ npm: '@ai-sdk/alibaba' })
    expect(result).toMatchObject({ transport: 'alibaba-sdk', safeToCompile: true })
  })

  it('resolves @ai-sdk/anthropic to anthropic', () => {
    const result = resolveReasoningTransport({ npm: '@ai-sdk/anthropic' })
    expect(result).toMatchObject({ transport: 'anthropic', safeToCompile: true })
  })

  it('treats openai-compatible + unknown baseURL as unknown', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://gateway.example.com/v1',
      providerId: 'my-gateway',
    })
    expect(result).toMatchObject({
      transport: 'unknown',
      safeToCompile: false,
    })
  })

  it('infers openai-compatible effort for an official model effort capability', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://gateway.example.com/v1',
      providerId: 'my-gateway',
      capability: {
        reasoning: true,
        options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
        source: 'official-registry',
        confidence: 'model-official',
      },
    })
    expect(result).toMatchObject({
      transport: 'openai-compatible-effort',
      confidence: 'medium',
      reason: 'official-model-openai-compatible-effort-inferred',
      safeToCompile: true,
    })
  })

  it('does not infer openai-compatible effort from non-official metadata', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      capability: {
        reasoning: true,
        options: [{ type: 'effort', values: ['low', 'high'] }],
        source: 'models.dev',
        confidence: 'high',
      },
    })
    expect(result).toMatchObject({ transport: 'unknown', safeToCompile: false })
  })

  it('does not infer an effort transport for official toggle-only controls', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      capability: {
        reasoning: true,
        options: [{ type: 'toggle' }],
        source: 'official-registry',
        confidence: 'model-official',
      },
    })
    expect(result).toMatchObject({ transport: 'unknown', safeToCompile: false })
  })

  it('treats qwen through an unknown gateway as unknown (no model-name guessing)', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      baseURL: 'https://gateway.example.com/v1',
      providerId: 'my-gateway',
      canonical: { discoveredModelId: 'qwen-x', canonicalModelId: 'alibaba/qwen-x', source: 'unique-model-id', confidence: 'high' },
      capability: { reasoning: true, options: [{ type: 'toggle' }], source: 'models.dev', confidence: 'high' },
    })
    expect(result).toMatchObject({ transport: 'unknown', safeToCompile: false })
  })

  it('treats unknown npm as unknown', () => {
    const result = resolveReasoningTransport({ npm: 'some-unknown-sdk' })
    expect(result).toMatchObject({ transport: 'unknown', safeToCompile: false })
  })

  it('rejects unrecognized explicit transport values', () => {
    expect(normalizeExplicitTransport('my-custom-transport')).toBeUndefined()
    expect(normalizeExplicitTransport(42)).toBeUndefined()
  })

  it('normalizes explicit transport names', () => {
    expect(normalizeExplicitTransport('openai-compatible-effort')).toBe('openai-compatible-effort')
    expect(normalizeExplicitTransport('DashScope')).toBe('dashscope-chat')
    expect(normalizeExplicitTransport('openrouter')).toBe('openrouter')
    expect(normalizeExplicitTransport('auto')).toBeUndefined()
    expect(reasoningTransportTestUtils.normalizeExplicitTransport('alibaba-sdk')).toBe('alibaba-sdk')
  })
})
