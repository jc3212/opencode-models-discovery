import { describe, it, expect } from 'vitest'
import { resolveReasoningTransport } from '../src/reasoning/transport'
import { getTransportAdapter } from '../src/reasoning/adapters'

/**
 * Official OpenAI transport (Responses API) registration.
 */
describe('official OpenAI transport', () => {
  it('resolves @ai-sdk/openai npm to the openai transport', () => {
    const result = resolveReasoningTransport({ npm: '@ai-sdk/openai' })
    expect(result).toMatchObject({
      transport: 'openai',
      confidence: 'exact',
      reason: 'known-provider-profile',
      safeToCompile: true,
    })
  })

  it('resolves explicit openai transport', () => {
    const result = resolveReasoningTransport({ npm: '@ai-sdk/openai-compatible', explicitTransport: 'openai' })
    expect(result).toMatchObject({ transport: 'openai', safeToCompile: true })
  })

  it('has an adapter registered', () => {
    expect(getTransportAdapter('openai')).toBeDefined()
  })

  it('maps effort to reasoningEffort model option', () => {
    const adapter = getTransportAdapter('openai')!
    expect(adapter.compileEffort?.('high')).toEqual({ reasoningEffort: 'high' })
  })
})
