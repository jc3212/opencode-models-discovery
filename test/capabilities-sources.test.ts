import { describe, expect, it } from 'vitest'

import { CapabilityCatalog } from '../src/capabilities/catalog'
import { providerNativeEvidence } from '../src/capabilities/sources/provider-native'
import { officialRegistryEvidence } from '../src/capabilities/sources/official-registry'
import { publicShadowEvidence } from '../src/capabilities/sources/models-dev'
import { manualOverrideEvidence } from '../src/capabilities/sources/manual'
import { SourcePolicyError } from '../src/capabilities/sources/common'
import type { ReasoningCapabilityEvidence } from '../src/capabilities/types'

const SCOPE = {
  inventoryIdentityHash: 'a'.repeat(64),
  routeKey: 'route-1',
  providerKind: 'openai-compatible',
  origin: 'https://relay.example.com',
  remoteModelId: 'model-x',
  apiSurface: 'chat-completions',
} as const

const T = { receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' }

function draft(overrides?: Partial<ReasoningCapabilityEvidence>) {
  return {
    claim: 'reasoning.support' as const,
    scope: { ...SCOPE },
    support: 'supported' as const,
    completeness: 'partial' as const,
    ...overrides,
  }
}

describe('provider-native source', () => {
  it('stamps provenance and defaults to exact authority', () => {
    const e = providerNativeEvidence({ ...draft(), sourceId: 'wire-obs-1', ...T })
    expect(e.source.id).toBe('provider-native:wire-obs-1')
    expect(e.authority).toBe('exact')
  })

  it('is accepted by the catalog', () => {
    const catalog = new CapabilityCatalog()
    expect(catalog.add(providerNativeEvidence({
      ...draft(),
      claim: 'effort.accepted',
      values: ['low', 'high'],
      sourceId: 'api-docs',
      ...T,
    }))).toEqual({ ok: true })
  })
})

describe('official-registry source', () => {
  it('requires per-entry url and revision', () => {
    expect(() => officialRegistryEvidence({
      ...draft(), sourceId: 'entry-1', ...T,
    } as never)).toThrow(SourcePolicyError)
    const e = officialRegistryEvidence({
      ...draft(), sourceId: 'entry-1', url: 'https://docs.example.com/x', revision: 'r7', ...T,
    })
    expect(e.source.id).toBe('official-registry:entry-1')
    expect(e.source.revision).toBe('r7')
    expect(e.authority).toBe('high')
  })
})

describe('public-shadow source', () => {
  it('caps authority at low and prefixes shadow provenance', () => {
    const e = publicShadowEvidence({
      ...draft(),
      claim: 'effort.effective',
      values: ['low'],
      scope: { ...SCOPE, apiSurface: 'unknown' },
      sourceId: 'models-dev#model-x',
      ...T,
    })
    expect(e.source.id).toBe('public-shadow:models-dev#model-x')
    expect(e.authority).toBe('low')
    expect(e.scope.apiSurface).toBe('unknown')
  })

  it('refuses provider-surface control and transport claims outright', () => {
    expect(() => publicShadowEvidence({
      ...draft(), claim: 'effort.accepted', values: ['low'], scope: { ...SCOPE }, sourceId: 'x', ...T,
    })).toThrow(SourcePolicyError)
    expect(() => publicShadowEvidence({
      ...draft(), claim: 'transport.wire', scope: { ...SCOPE }, sourceId: 'x', ...T,
    })).toThrow(SourcePolicyError)
  })

  it('never guesses an undeclared surface', () => {
    expect(() => publicShadowEvidence({
      ...draft(), scope: { ...SCOPE, apiSurface: '' as typeof SCOPE.apiSurface }, sourceId: 'x', ...T,
    })).toThrow(SourcePolicyError)
  })

  it('keeps a source-declared surface verbatim when provided', () => {
    const e = publicShadowEvidence({
      ...draft(),
      scope: { ...SCOPE, apiSurface: 'responses' },
      declaredSurface: 'responses',
      sourceId: 'x',
      ...T,
    })
    expect(e.scope.apiSurface).toBe('responses')
  })

  it('cannot exceed low authority even if asked', () => {
    expect(() => publicShadowEvidence({
      ...draft(),
      claim: 'canonical.identity',
      scalar: 'canonical-x',
      authority: 'exact',
      scope: { ...SCOPE },
      sourceId: 'x',
      ...T,
    })).toThrow(SourcePolicyError)
  })
})

describe('manual override source', () => {
  it('labels configuration intent as manual with medium authority', () => {
    const e = manualOverrideEvidence({
      ...draft(),
      claim: 'effort.accepted',
      values: ['low', 'max'],
      sourceId: 'user-config',
      ...T,
    })
    expect(e.source.id).toBe('manual:user-config')
    expect(e.authority).toBe('medium')
  })
})

describe('cross-source catalog flow', () => {
  it('stores same claim from different source classes on one tuple', () => {
    const catalog = new CapabilityCatalog()
    expect(catalog.add(publicShadowEvidence({
      ...draft(), claim: 'effort.effective', values: ['low'], scope: { ...SCOPE }, sourceId: 'md', ...T,
    }))).toEqual({ ok: true })
    expect(catalog.add(manualOverrideEvidence({
      ...draft(), claim: 'effort.accepted', values: ['max'], sourceId: 'cfg', ...T,
    }))).toEqual({ ok: true })
    expect(catalog.size()).toBe(1)
  })
})
