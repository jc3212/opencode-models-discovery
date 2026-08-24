import { describe, expect, it } from 'vitest'

import { buildVariantPlan } from '../src/reasoning/variant-plan'
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

function rec(overrides: Partial<ReasoningCapabilityEvidence>): ReasoningCapabilityEvidence {
  return {
    claim: 'reasoning.support',
    scope: { ...SCOPE },
    support: 'supported',
    completeness: 'partial',
    authority: 'high',
    source: { id: 's1', ...T },
    ...overrides,
  }
}

const BASE = {
  accessEligible: true,
  requestedSurface: 'chat-completions',
}

describe('buildVariantPlan gates', () => {
  it('refuses ineligible routes before anything else', () => {
    expect(buildVariantPlan({
      ...BASE,
      accessEligible: false,
      records: [rec({})],
    })).toEqual({ kind: 'empty', reason: 'not-access-eligible' })
  })

  it('blocks unknown-surface records from compiling a declared surface', () => {
    expect(buildVariantPlan({
      ...BASE,
      records: [rec({ scope: { ...SCOPE, apiSurface: 'unknown' } })],
    })).toEqual({ kind: 'empty', reason: 'surface-gate-blocked' })
  })

  it('rejects mixed-tuple record sets to prevent cross-provider leakage', () => {
    expect(() => buildVariantPlan({
      ...BASE,
      records: [
        rec({}),
        rec({ scope: { ...SCOPE, remoteModelId: 'model-y' } }),
      ],
    })).toThrow(TypeError)
  })
})

describe('support state separation (unknown vs unsupported)', () => {
  it('distinguishes unknown from unsupported support', () => {
    expect(buildVariantPlan({
      ...BASE,
      records: [rec({ support: 'unknown' })],
    }).kind === 'empty' && buildVariantPlan({
      ...BASE,
      records: [rec({ support: 'unknown' })],
    }).reason).toBe('capability-unknown')

    expect(buildVariantPlan({
      ...BASE,
      records: [rec({ support: 'unsupported', completeness: 'exhaustive' })],
    })).toEqual({ kind: 'empty', reason: 'capability-unsupported' })
  })
})

describe('effective-domain compilation', () => {
  it('compiles authoritative effective values with provenance and default', () => {
    const plan = buildVariantPlan({
      ...BASE,
      records: [
        rec({ completeness: 'exhaustive' }),
        rec({
          claim: 'effort.effective',
          values: ['low', 'max'],
          source: { id: 'eff-src', revision: '3', ...T },
        }),
        rec({
          claim: 'effort.default',
          scalar: 'low',
          source: { id: 'def-src', ...T },
        }),
      ],
    })
    if (plan.kind !== 'planned') throw new Error(`unexpected: ${JSON.stringify(plan)}`)
    expect(plan.variants.map((v) => v.effective)).toEqual(['low', 'max'])
    expect(plan.defaultEffort).toBe('low')
    expect(plan.variants[0].provenance.effectiveSourceId).toBe('eff-src')
    expect(plan.variants[0].provenance.defaultSourceId).toBe('def-src')
  })

  it('maps accepted inputs through normalization into the effective domain', () => {
    const plan = buildVariantPlan({
      ...BASE,
      records: [
        rec({ completeness: 'exhaustive' }),
        rec({ claim: 'effort.accepted', values: ['xhigh', 'max'] }),
        rec({
          claim: 'effort.normalization',
          normalization: { xhigh: 'high' },
          preferredWireByEffective: { high: 'high', max: 'max' },
          source: { id: 'norm-src', ...T },
        }),
      ],
    })
    if (plan.kind !== 'planned') throw new Error(`unexpected: ${JSON.stringify(plan)}`)
    expect(plan.variants.map((v) => v.effective)).toEqual(['high', 'max'])
    // Explicit wire mapping wins over identity.
    expect(plan.variants.map((v) => v.wireValue)).toEqual(['high', 'max'])
    expect(plan.variants.every((v) => v.explicitWire)).toBe(true)
    expect(plan.variants[0].provenance.normalizationSourceId).toBe('norm-src')
  })

  it('drops unmapped non-enum accepted values instead of guessing', () => {
    const plan = buildVariantPlan({
      ...BASE,
      records: [
        rec({ completeness: 'exhaustive' }),
        rec({ claim: 'effort.accepted', values: ['weird-tier'] }),
      ],
    })
    expect(plan).toEqual({ kind: 'empty', reason: 'no-effective-values' })
  })

  it('falls back to identity wire values without explicit mappings', () => {
    const plan = buildVariantPlan({
      ...BASE,
      records: [
        rec({ completeness: 'exhaustive' }),
        rec({ claim: 'effort.effective', values: ['medium'] }),
      ],
    })
    if (plan.kind !== 'planned') throw new Error('unreachable')
    expect(plan.variants[0]).toMatchObject({
      effective: 'medium',
      wireValue: 'medium',
      explicitWire: false,
    })
  })

  it('propagates ambiguity as an explicit suppression reason', () => {
    const plan = buildVariantPlan({
      ...BASE,
      records: [
        rec({ completeness: 'exhaustive' }),
        rec({
          claim: 'effort.effective',
          values: ['low'],
          authority: 'exact',
          completeness: 'exhaustive',
          source: { id: 'a', ...T },
        }),
        rec({
          claim: 'effort.effective',
          values: ['high'],
          authority: 'exact',
          completeness: 'exhaustive',
          scope: { ...SCOPE, remoteModelId: SCOPE.remoteModelId },
          source: { id: 'b', ...T },
        }),
      ],
    })
    expect(plan).toEqual({ kind: 'empty', reason: 'claims-ambiguous', detail: expect.any(String) })
  })
})
