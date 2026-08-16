import { describe, it, expect } from 'vitest'
import { KNOWN_PROVIDER_PROFILES } from '../src/reasoning/profiles'
import { resolveReasoningTransport } from '../src/reasoning/transport'

/**
 * Phase F: profile admission rules (design §22-23).
 *
 * Every registered automatic profile must carry evidence (official docs,
 * SDK source, or wire test). Provider/model-name guessing and blanket relay
 * profiles are prohibited.
 */
describe('provider profile admission', () => {
  it('every profile has at least one piece of evidence', () => {
    for (const profile of KNOWN_PROVIDER_PROFILES) {
      expect(profile.evidence?.length, profile.id).toBeGreaterThan(0)
    }
  })

  it('every profile has a wire-test or sdk-source/official-doc evidence', () => {
    for (const profile of KNOWN_PROVIDER_PROFILES) {
      const types = profile.evidence.map((e) => e.type)
      expect(['wire-test', 'sdk-source', 'official-doc'].some((t) => types.includes(t as any)), profile.id).toBe(true)
    }
  })

  it('no blanket relay profiles are registered (newapi/sub2api/one-api/relay)', () => {
    const relayIds = ['newapi', 'sub2api', 'one-api', 'oneapi', 'relay', 'new-api']
    for (const profile of KNOWN_PROVIDER_PROFILES) {
      expect(relayIds.includes(profile.id), profile.id).toBe(false)
    }
  })

  it('relay provider ids still resolve to unknown transport', () => {
    for (const id of ['newapi', 'sub2api', 'oneapi']) {
      const result = resolveReasoningTransport({
        npm: '@ai-sdk/openai-compatible',
        providerId: id,
        baseURL: 'https://gw.example.com/v1',
      })
      expect(result.transport, id).toBe('unknown')
    }
  })

  it('profiles resolve their declared transports', () => {
    const expectations: Record<string, string> = {
      openrouter: 'openrouter',
      'dashscope-chat': 'dashscope-chat',
      'alibaba-sdk': 'alibaba-sdk',
      anthropic: 'anthropic',
      google: 'google',
    }
    for (const profile of KNOWN_PROVIDER_PROFILES) {
      const expected = expectations[profile.id]
      if (expected !== undefined) {
        expect(profile.transport, profile.id).toBe(expected)
      }
    }
  })
})
