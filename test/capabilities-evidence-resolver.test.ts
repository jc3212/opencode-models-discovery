import { describe, expect, it } from 'vitest'

import { resolveClaim } from '../src/capabilities/evidence-resolver'
import type { ReasoningCapabilityEvidence } from '../src/capabilities/types'

const SCOPE = {
  inventoryIdentityHash: 'a'.repeat(64),
  routeKey: 'route-1',
  providerKind: 'openai-compatible',
  origin: 'https://relay.example.com',
  remoteModelId: 'model-x',
  apiSurface: 'chat-completions',
} as const

function rec(overrides: Partial<ReasoningCapabilityEvidence>): ReasoningCapabilityEvidence {
  return {
    claim: 'effort.accepted',
    scope: { ...SCOPE },
    support: 'supported',
    completeness: 'partial',
    authority: 'high',
    source: { id: 's1', receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' },
    ...overrides,
  }
}

describe('resolveClaim', () => {
  it('is unresolved with no records or only unknown records', () => {
    expect(resolveClaim({ claim: 'effort.accepted', records: [] }))
      .toEqual({ kind: 'unresolved', reason: 'no-records' })
    expect(resolveClaim({
      claim: 'effort.accepted',
      records: [rec({ support: 'unknown' })],
    })).toEqual({ kind: 'unresolved', reason: 'all-unknown' })
  })

  it('ignores records of other claims', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [rec({ claim: 'reasoning.support' }), rec({ values: ['low'] })],
    })
    expect(r).toMatchObject({ kind: 'resolved', values: ['low'] })
  })

  it('accumulates partial positives and applies explicit negatives', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [
        rec({ values: ['low', 'medium'], source: { id: 'a', receivedAt: 't1', activatedAt: 't1' } }),
        rec({ source: { id: 'b', receivedAt: 't2', activatedAt: 't2' }, values: ['medium', 'high'] }),
        rec({ source: { id: 'c', receivedAt: 't3', activatedAt: 't3' }, negativeValues: ['medium'] }),
      ],
    })
    expect(r).toMatchObject({ kind: 'resolved', values: ['high', 'low'], completeness: 'partial' })
  })

  it('never treats missing values as negative', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [
        rec({ values: ['low'] }),
        rec({ source: { id: 'z', receivedAt: 't9', activatedAt: 't9' }, support: 'supported' }),
      ],
    })
    expect(r).toMatchObject({ kind: 'resolved', values: ['low'] })
  })

  it('an empty partial array contributes nothing and stays unknown-ish', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [rec({ values: [] })],
    })
    expect(r).toMatchObject({ kind: 'resolved', values: [], completeness: 'partial' })
  })

  it('exhaustive fixes the set, stops lower ranks, and authorizes empty', () => {
    const stopLower = resolveClaim({
      claim: 'effort.accepted',
      records: [
        // Lower rank but newest revision must still lose to exhaustive.
        rec({ authority: 'low', values: ['max'], source: { id: 'a', revision: '9', receivedAt: 't5', activatedAt: 't5' } }),
        rec({ completeness: 'exhaustive', values: ['low', 'medium'], source: { id: 'b', revision: '2', receivedAt: 't1', activatedAt: 't1' } }),
      ],
    })
    expect(stopLower).toMatchObject({
      kind: 'resolved',
      values: ['low', 'medium'],
      completeness: 'exhaustive',
    })

    const empty = resolveClaim({
      claim: 'effort.accepted',
      records: [rec({ completeness: 'exhaustive', values: [] })],
    })
    expect(empty).toMatchObject({ kind: 'resolved', values: [], completeness: 'exhaustive' })
  })

  it('same-rank exhaustive disagreement resolves to ambiguity', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [
        rec({ completeness: 'exhaustive', values: ['low'], authority: 'exact' }),
        rec({ completeness: 'exhaustive', values: ['high'], authority: 'exact' }),
      ],
    })
    expect(r).toMatchObject({ kind: 'ambiguous' })
  })

  it('lower-rank disagreement after exhaustive is suppressed, not ambiguous', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [
        rec({ completeness: 'exhaustive', values: ['low'], authority: 'exact' }),
        rec({ values: ['max'], authority: 'medium' }),
      ],
    })
    expect(r).toMatchObject({ kind: 'resolved', values: ['low'], completeness: 'exhaustive' })
  })

  it('scalar claims take the top record and flag same-rank scalar conflicts', () => {
    const ok = resolveClaim({
      claim: 'effort.default',
      records: [
        rec({ claim: 'effort.default', scalar: 'low', authority: 'high' }),
        rec({ claim: 'effort.default', scalar: 'low', authority: 'high', source: { id: 's2', receivedAt: 't1', activatedAt: 't1' } }),
      ],
    })
    expect(ok).toMatchObject({ kind: 'resolved', scalar: 'low' })

    const conflict = resolveClaim({
      claim: 'effort.default',
      records: [
        rec({ claim: 'effort.default', scalar: 'low', authority: 'high' }),
        rec({ claim: 'effort.default', scalar: 'high', authority: 'high', source: { id: 's2', receivedAt: 't1', activatedAt: 't1' } }),
      ],
    })
    expect(conflict).toMatchObject({ kind: 'ambiguous' })
  })

  it('orders by revision before authority deterministically', () => {
    const r = resolveClaim({
      claim: 'effort.accepted',
      records: [
        rec({ authority: 'exact', values: ['stale-set'], source: { id: 'a', revision: '1', receivedAt: 't1', activatedAt: 't1' } }),
        rec({ authority: 'low', values: ['fresh-set'], source: { id: 'b', revision: '7', receivedAt: 't1', activatedAt: 't1' } }),
      ],
    })
    // Revision 7 is applied first; §10.3 rule 3 accumulates positive values
    // across ranks for partial records — order only governs exhaustive stop
    // and scalar precedence.
    expect(r).toMatchObject({ kind: 'resolved', values: ['fresh-set', 'stale-set'] })
  })
})
