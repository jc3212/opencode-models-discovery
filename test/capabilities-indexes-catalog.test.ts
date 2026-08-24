import { describe, expect, it } from 'vitest'

import {
  CapabilityIndex,
  catalogProviderKey,
  DuplicateCapabilityEntryError,
  satisfiesSurfaceGate,
  UNKNOWN_SURFACE,
} from '../src/capabilities/indexes'
import { CapabilityCatalog } from '../src/capabilities/catalog'
import type { ReasoningCapabilityEvidence } from '../src/capabilities/types'

const BASE_SCOPE = {
  inventoryIdentityHash: 'a'.repeat(64),
  routeKey: 'route-1',
  providerKind: 'openai-compatible',
  origin: 'https://relay.example.com',
  remoteModelId: 'model-x',
  apiSurface: 'chat-completions',
} as const

function evidence(overrides?: Partial<ReasoningCapabilityEvidence>): ReasoningCapabilityEvidence {
  return {
    claim: 'reasoning.support',
    scope: { ...BASE_SCOPE },
    support: 'supported',
    completeness: 'exhaustive',
    authority: 'exact',
    source: { id: 'src-1', receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' },
    ...overrides,
  }
}

describe('CapabilityIndex', () => {
  it('stores and looks up exact tuples only', () => {
    const index = new CapabilityIndex<string>()
    const key = { providerKey: 'p@https://o', surface: 'chat-completions', remoteModelId: 'm1' }
    index.insert(key, 'v1')
    expect(index.lookupExact(key)).toEqual(['v1'])
    expect(index.lookupExact({ ...key, surface: 'responses' })).toBeUndefined()
    expect(index.lookupExact({ ...key, remoteModelId: 'M1' })).toBeUndefined()
    expect(index.lookupExact({ ...key, providerKey: 'p@https://other' })).toBeUndefined()
  })

  it('treats exact duplicates as failure instead of overwrite', () => {
    const index = new CapabilityIndex<string>()
    const key = { providerKey: 'p', surface: 's', remoteModelId: 'm' }
    index.insert(key, 'first')
    expect(() => index.insert(key, 'second')).toThrow(DuplicateCapabilityEntryError)
    expect(index.lookupExact(key)).toEqual(['first'])
  })

  it('rejects empty tuple components and surfaces cross-surface diagnostics', () => {
    const index = new CapabilityIndex<string>()
    expect(() => index.insert({ providerKey: '', surface: 's', remoteModelId: 'm' }, 'x')).toThrow(TypeError)
    index.insert({ providerKey: 'p', surface: 'b-surface', remoteModelId: 'm' }, 'vb')
    index.insert({ providerKey: 'p', surface: 'a-surface', remoteModelId: 'm' }, 'va')
    expect(index.lookupByModel('p', 'm').map((e) => e.surface)).toEqual(['a-surface', 'b-surface'])
    expect(index.size()).toBe(2)
  })
})

describe('satisfiesSurfaceGate', () => {
  it('never unlocks control/transport for unknown or empty surfaces', () => {
    expect(satisfiesSurfaceGate(UNKNOWN_SURFACE, 'chat-completions')).toBe(false)
    expect(satisfiesSurfaceGate('', undefined)).toBe(false)
    expect(satisfiesSurfaceGate(UNKNOWN_SURFACE, undefined)).toBe(false)
    expect(satisfiesSurfaceGate('chat-completions', 'chat-completions')).toBe(true)
    expect(satisfiesSurfaceGate('chat-completions')).toBe(true)
    expect(satisfiesSurfaceGate('responses', 'chat-completions')).toBe(false)
  })
})

describe('catalogProviderKey', () => {
  it('derives a stable key and rejects empties', () => {
    expect(catalogProviderKey({ providerKind: 'k', origin: 'o' })).toBe('k@o')
    expect(() => catalogProviderKey({ providerKind: '', origin: 'o' })).toThrow(TypeError)
  })
})

function validCatalog(): CapabilityCatalog {
  return new CapabilityCatalog()
}

describe('CapabilityCatalog.add', () => {
  it('accepts valid evidence and indexes multiple claims per tuple', () => {
    const catalog = validCatalog()
    expect(catalog.add(evidence())).toEqual({ ok: true })
    expect(catalog.add(evidence({ claim: 'effort.accepted', values: ['low', 'high'] }))).toEqual({ ok: true })
    expect(catalog.size()).toBe(1)
    const claims = catalog.lookupExact({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      apiSurface: 'chat-completions',
      remoteModelId: 'model-x',
    })
    expect(claims?.size).toBe(2)
  })

  it('rejects invalid evidence fail-closed without indexing', () => {
    const catalog = validCatalog()
    const result = catalog.add(evidence({
      // Incompatible field for this claim → invalid.
      values: ['x'],
    } as Partial<ReasoningCapabilityEvidence>))
    expect(result).toMatchObject({ ok: false, reason: 'invalid-evidence' })
    expect(catalog.size()).toBe(0)
  })

  it('reports same-claim re-assertion as duplicate instead of overwriting', () => {
    const catalog = validCatalog()
    catalog.add(evidence())
    const second = catalog.add(evidence({ support: 'unsupported' }))
    expect(second).toMatchObject({ ok: false, reason: 'duplicate-claim' })
    const stored = catalog.lookupExact({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      apiSurface: 'chat-completions',
      remoteModelId: 'model-x',
    })
    expect(stored?.get('reasoning.support')?.support).toBe('supported')
  })

  it('keeps different models and origins separate', () => {
    const catalog = validCatalog()
    catalog.add(evidence())
    catalog.add(evidence({ scope: { ...BASE_SCOPE, remoteModelId: 'model-y' } }))
    catalog.add(evidence({ scope: { ...BASE_SCOPE, origin: 'https://other.example.com' } }))
    expect(catalog.size()).toBe(3)
  })
})

describe('CapabilityCatalog lookup gating', () => {
  it('withholds unknown-surface entries from gated lookups but lists them as candidates', () => {
    const catalog = validCatalog()
    const unknown = evidence({ scope: { ...BASE_SCOPE, apiSurface: UNKNOWN_SURFACE } })
    expect(catalog.add(unknown)).toEqual({ ok: true })

    expect(catalog.lookupExact({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      apiSurface: UNKNOWN_SURFACE,
      remoteModelId: 'model-x',
      requested: 'chat-completions',
    })).toBeUndefined()

    const ungated = catalog.lookupExact({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      apiSurface: UNKNOWN_SURFACE,
      remoteModelId: 'model-x',
    })
    expect(ungated?.get('reasoning.support')?.claim).toBe('reasoning.support')

    const candidates = catalog.lookupCandidates({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      remoteModelId: 'model-x',
    })
    expect(candidates.map((c) => c.surface)).toEqual([UNKNOWN_SURFACE])
  })

  it('enforces exact declared-surface matching on gated lookups', () => {
    const catalog = validCatalog()
    catalog.add(evidence())
    expect(catalog.lookupExact({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      apiSurface: 'chat-completions',
      remoteModelId: 'model-x',
      requested: 'responses',
    })).toBeUndefined()
    expect(catalog.lookupExact({
      providerKind: BASE_SCOPE.providerKind,
      origin: BASE_SCOPE.origin,
      apiSurface: 'chat-completions',
      remoteModelId: 'model-x',
      requested: 'chat-completions',
    })?.size).toBe(1)
  })
})
