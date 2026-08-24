import { describe, expect, it } from 'vitest'

import type { AccessEvidence } from '../src/discovery/types'
import {
  EvidenceLedger,
  MAX_EVIDENCE_PER_OBSERVATION,
  deriveEvidenceFromObservation,
} from '../src/discovery/evidence/ledger'

const BASE = {
  inventoryIdentityHash: 'a'.repeat(64),
  source: { adapterId: 'generic-openai', endpoint: '/v1/models' },
  receivedAt: '2026-08-24T00:00:00.000Z',
} as const

describe('deriveEvidenceFromObservation', () => {
  it('derives exhaustive allowed records from a complete non-empty listing', () => {
    const records = deriveEvidenceFromObservation({
      ...BASE,
      outcome: 'complete-nonempty',
      observedRouteKeys: ['m2', 'm1', 'm2', ''],
    })
    expect(records.map((r) => r.routeKey)).toEqual(['m1', 'm2'])
    expect(records.every((r) => r.claim === 'credential-visible')).toBe(true)
    expect(records.every((r) => r.state === 'allowed' && r.completeness === 'exhaustive')).toBe(true)
    expect(records[0].source.receivedAt).toBe(BASE.receivedAt)
    expect(records[0].source.adapterId).toBe('generic-openai')
  })

  it('derives partial records for a partial listing', () => {
    const records = deriveEvidenceFromObservation({
      ...BASE,
      outcome: 'partial',
      observedRouteKeys: ['m1'],
    })
    expect(records).toHaveLength(1)
    expect(records[0].completeness).toBe('partial')
    expect(records[0].state).toBe('allowed')
  })

  it('never mints records without observed routes', () => {
    for (const outcome of [
      'complete-empty',
      'not-modified',
      'invalid',
      'transient-failure',
      'auth-failure',
    ] as const) {
      const records = deriveEvidenceFromObservation({ ...BASE, outcome })
      expect(records, outcome).toEqual([])
    }
  })

  it('rejects an empty identity hash instead of minting unscoped evidence', () => {
    const records = deriveEvidenceFromObservation({
      ...BASE,
      inventoryIdentityHash: '',
      outcome: 'complete-nonempty',
      observedRouteKeys: ['m1'],
    })
    expect(records).toEqual([])
  })

  it('keeps optional revision in source and omits it otherwise', () => {
    const withRevision = deriveEvidenceFromObservation({
      ...BASE,
      source: { ...BASE.source, revision: 'rev-7' },
      outcome: 'complete-nonempty',
      observedRouteKeys: ['m1'],
    })[0] as AccessEvidence
    expect(withRevision.source.revision).toBe('rev-7')

    const withoutRevision = deriveEvidenceFromObservation({
      ...BASE,
      outcome: 'complete-nonempty',
      observedRouteKeys: ['m1'],
    })[0]
    expect('revision' in withoutRevision.source).toBe(false)
  })

  it('caps derived records per observation deterministically', () => {
    const keys = Array.from({ length: MAX_EVIDENCE_PER_OBSERVATION + 50 }, (_, i) => `k${i}`)
    const records = deriveEvidenceFromObservation({
      ...BASE,
      outcome: 'complete-nonempty',
      observedRouteKeys: keys,
    })
    expect(records).toHaveLength(MAX_EVIDENCE_PER_OBSERVATION)
    // Sorted keys truncated deterministically: first cap entries in sorted order.
    expect(records[MAX_EVIDENCE_PER_OBSERVATION - 1].routeKey < `k${MAX_EVIDENCE_PER_OBSERVATION + 49}`).toBe(true)
  })

  it('is deterministic for identical inputs', () => {
    const input = {
      ...BASE,
      outcome: 'complete-nonempty' as const,
      observedRouteKeys: ['b', 'a'],
    }
    expect(deriveEvidenceFromObservation(input)).toEqual(deriveEvidenceFromObservation(input))
  })
})

describe('EvidenceLedger', () => {
  const ID_A = 'a'.repeat(64)
  const ID_B = 'b'.repeat(64)

  function rec(hash: string, routeKey: string, receivedAt: string): AccessEvidence {
    return {
      inventoryIdentityHash: hash,
      routeKey,
      claim: 'credential-visible',
      state: 'allowed',
      completeness: 'exhaustive',
      source: { adapterId: 'generic-openai', endpoint: '/v1/models', receivedAt },
    }
  }

  it('scopes records by identity hash with no cross-identity bleed', () => {
    const ledger = new EvidenceLedger()
    ledger.record(rec(ID_A, 'm1', 't1'))
    ledger.record(rec(ID_B, 'm2', 't2'))
    expect(ledger.query({ inventoryIdentityHash: ID_A }).map((r) => r.routeKey)).toEqual(['m1'])
    expect(ledger.query({ inventoryIdentityHash: ID_B }).map((r) => r.routeKey)).toEqual(['m2'])
    expect(ledger.query({ inventoryIdentityHash: 'c'.repeat(64) })).toEqual([])
    expect(ledger.size()).toBe(2)
    expect(ledger.size(ID_A)).toBe(1)
  })

  it('ignores exact duplicates and evicts oldest beyond the bound', () => {
    const ledger = new EvidenceLedger({ maxEntriesPerIdentity: 2 })
    ledger.record(rec(ID_A, 'm1', 't1'))
    ledger.record(rec(ID_A, 'm1', 't1'))
    ledger.record(rec(ID_A, 'm2', 't2'))
    ledger.record(rec(ID_A, 'm3', 't3'))
    const routes = ledger.query({ inventoryIdentityHash: ID_A }).map((r) => r.routeKey)
    expect(routes).toEqual(['m2', 'm3'])
    expect(ledger.size(ID_A)).toBe(2)
  })

  it('filters by route key and returns stable sorted output', () => {
    const ledger = new EvidenceLedger()
    ledger.record([rec(ID_A, 'm2', 't1'), rec(ID_A, 'm1', 't1'), rec(ID_A, 'm1', 't0')])
    const all = ledger.query({ inventoryIdentityHash: ID_A })
    expect(all.map((r) => `${r.source.receivedAt}/${r.routeKey}`)).toEqual([
      't0/m1',
      't1/m1',
      't1/m2',
    ])
    const one = ledger.query({ inventoryIdentityHash: ID_A, routeKey: 'm1' })
    expect(one.map((r) => r.routeKey)).toEqual(['m1', 'm1'])
  })

  it('returns defensive copies that cannot mutate stored state', () => {
    const ledger = new EvidenceLedger()
    ledger.record(rec(ID_A, 'm1', 't1'))
    const copy = ledger.query({ inventoryIdentityHash: ID_A })[0]
    copy.routeKey = 'tampered'
    copy.source.endpoint = '/tampered'
    expect(ledger.query({ inventoryIdentityHash: ID_A })[0].routeKey).toBe('m1')
    expect(ledger.query({ inventoryIdentityHash: ID_A })[0].source.endpoint).toBe('/v1/models')
  })

  it('clears everything and tolerates invalid constructor bounds', () => {
    const ledger = new EvidenceLedger({ maxEntriesPerIdentity: -5 })
    ledger.record(rec(ID_A, 'm1', 't1'))
    ledger.clear()
    expect(ledger.size()).toBe(0)
    expect(ledger.query({ inventoryIdentityHash: ID_A })).toEqual([])
  })
})
