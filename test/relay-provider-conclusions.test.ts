import { describe, it, expect } from 'vitest'
import { resolveReasoningTransport } from '../src/reasoning/transport'

/**
 * Phase G/H objective conclusions (design §24-26).
 *
 * New API (QuantumNous/new-api) and Sub2API are multi-channel relays:
 *   - New API forwards reasoning controls differently per channel type
 *     (OpenAI/Azure vs OpenRouter vs Anthropic); /v1/models returns no
 *     reasoning_options.
 *   - Sub2API proxies OpenAI, Anthropic, Gemini protocols and can route
 *     through hybrid/Antigravity channels.
 *
 * Therefore neither provider id alone is evidence of a single reasoning
 * transport. No blanket profile may be registered; transport stays unknown
 * unless the user configures it explicitly.
 */
describe('New API / Sub2API transport resolution (no blanket profiles)', () => {
  it('treats a New API provider with unknown channel config as unknown transport', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      providerId: 'newapi',
      baseURL: 'https://newapi.example.com/v1',
    })
    expect(result).toMatchObject({ transport: 'unknown', safeToCompile: false })
  })

  it('treats a Sub2API provider as unknown transport without explicit config', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example.com/v1',
    })
    expect(result).toMatchObject({ transport: 'unknown', safeToCompile: false })
  })

  it('resolves when the user explicitly configures the transport', () => {
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      providerId: 'newapi',
      baseURL: 'https://newapi.example.com/v1',
      explicitTransport: 'openai-compatible-effort',
    })
    expect(result).toMatchObject({ transport: 'openai-compatible-effort', safeToCompile: true })
  })

  it('does not treat the provider id as a transport hint', () => {
    // 'newapi' / 'sub2api' are NOT registered as provider profiles.
    const result = resolveReasoningTransport({
      npm: '@ai-sdk/openai-compatible',
      providerId: 'sub2api',
      baseURL: 'https://gw.example.com/v1',
    })
    expect(result.transport).toBe('unknown')
  })
})
