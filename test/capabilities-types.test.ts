import { describe, expect, it } from 'vitest'

import {
  CLAIM_ALLOWED_FIELDS,
  validateReasoningCapabilityEvidence,
  type EvidenceScope,
  type ReasoningCapabilityEvidence,
} from '../src/capabilities/types'

const SCOPE: EvidenceScope = {
  inventoryIdentityHash: 'a'.repeat(64),
  routeKey: 'm1',
  providerKind: 'relay',
  origin: 'https://relay.example.com',
  remoteModelId: 'model-x',
  apiSurface: 'chat-completions',
}

function evidence(overrides?: Partial<ReasoningCapabilityEvidence>): ReasoningCapabilityEvidence {
  return {
    claim: 'effort.accepted',
    scope: SCOPE,
    support: 'supported',
    completeness: 'exhaustive',
    values: ['low', 'high', 'max'],
    authority: 'exact',
    source: { id: 'provider-docs', receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' },
    ...overrides,
  }
}

describe('CLAIM_ALLOWED_FIELDS (E4)', () => {
  it('covers exactly the ten frozen atomic claims', () => {
    expect(Object.keys(CLAIM_ALLOWED_FIELDS).sort()).toEqual([
      'budget.range',
      'canonical.identity',
      'effort.accepted',
      'effort.default',
      'effort.effective',
      'effort.normalization',
      'reasoning.mandatory',
      'reasoning.support',
      'toggle',
      'transport.wire',
    ])
  })
})

describe('validateReasoningCapabilityEvidence', () => {
  it('accepts a well-formed effort.accepted record', () => {
    expect(validateReasoningCapabilityEvidence(evidence())).toEqual({ ok: true })
  })

  it('rejects fields incompatible with the claim instead of ignoring them', () => {
    const withBudget = evidence({ budgetRange: { min: 0, max: 1 } })
    const result = validateReasoningCapabilityEvidence(withBudget)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('budgetRange')

    const withNormalization = evidence({
      normalization: { medium: 'high' },
    })
    const r2 = validateReasoningCapabilityEvidence(withNormalization)
    expect(r2.ok).toBe(false)
  })

  it('accepts schema-compatible payloads for their own claims', () => {
    expect(
      validateReasoningCapabilityEvidence(
        evidence({
          claim: 'effort.normalization',
          values: undefined,
          normalization: { medium: 'high', xhigh: 'high' },
          preferredWireByEffective: { high: '"high"' },
        }),
      ),
    ).toEqual({ ok: true })

    expect(
      validateReasoningCapabilityEvidence(
        evidence({
          claim: 'budget.range',
          values: undefined,
          budgetRange: { min: 1024, max: 32768, default: 8192 },
        }),
      ),
    ).toEqual({ ok: true })

    expect(
      validateReasoningCapabilityEvidence(
        evidence({
          claim: 'reasoning.mandatory',
          values: undefined,
          scalar: true,
        }),
      ),
    ).toEqual({ ok: true })
  })

  it('validates enums and scope sanity fail-closed', () => {
    expect(validateReasoningCapabilityEvidence(evidence({ support: 'maybe' })).ok).toBe(false)
    expect(validateReasoningCapabilityEvidence(evidence({ authority: 'ultimate' })).ok).toBe(false)
    expect(
      validateReasoningCapabilityEvidence(
        evidence({ scope: { ...SCOPE, inventoryIdentityHash: 'short' } }),
      ).ok,
    ).toBe(false)
    expect(
      validateReasoningCapabilityEvidence(evidence({ scope: { ...SCOPE, remoteModelId: '' } })).ok,
    ).toBe(false)
    expect(validateReasoningCapabilityEvidence(evidence({ source: { id: '' } as never })).ok).toBe(false)
  })

  it('rejects contradictory negativeValues on exhaustive supported sets', () => {
    const contradictory = evidence({
      negativeValues: ['minimal'],
    })
    expect(validateReasoningCapabilityEvidence(contradictory).ok).toBe(false)

    // Partial records may carry explicit negatives (missing ≠ negative).
    const partial = evidence({ completeness: 'partial', negativeValues: ['minimal'] })
    expect(validateReasoningCapabilityEvidence(partial)).toEqual({ ok: true })
  })

  it('rejects malformed normalization and budget payloads', () => {
    expect(
      validateReasoningCapabilityEvidence(
        evidence({ claim: 'effort.normalization', values: undefined, normalization: { medium: 'ultra' } }),
      ).ok,
    ).toBe(false)
    expect(
      validateReasoningCapabilityEvidence(
        evidence({ claim: 'budget.range', values: undefined, budgetRange: { min: 10, max: 5 } }),
      ).ok,
    ).toBe(false)
    expect(
      validateReasoningCapabilityEvidence(
        evidence({ claim: 'transport.wire', values: undefined, preferredWireByEffective: { ultra: 'x' } as never }),
      ).ok,
    ).toBe(false)
  })
})
