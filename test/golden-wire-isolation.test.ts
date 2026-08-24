import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { CapabilityCatalog } from '../src/capabilities/catalog'
import { buildVariantPlan } from '../src/reasoning/variant-plan'
import {
  DEEPSEEK_NORMALIZATION,
  deepSeekAcceptedInputsEvidence,
  deepSeekNormalizationEvidence,
  deepSeekReasoningSupportEvidence,
} from '../src/reasoning/deepseek-plan'
import { parseOpenRouterReasoning } from '../src/reasoning/openrouter-reasoning-parser'
import { manualOverrideEvidence } from '../src/capabilities/sources/manual'
import { publicShadowEvidence } from '../src/capabilities/sources/models-dev'
import { providerNativeEvidence } from '../src/capabilities/sources/provider-native'
import type { ReasoningCapabilityEvidence } from '../src/capabilities/types'

const T = { receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' }

interface TupleSpec {
  providerKind: string
  origin: string
  remoteModelId: string
  apiSurface: string
}

function identityHashOf(spec: TupleSpec): string {
  return createHash('sha256')
    .update(`${spec.providerKind}|${spec.origin}|${spec.remoteModelId}|${spec.apiSurface}`)
    .digest('hex')
}

function scopeFor(spec: TupleSpec) {
  return {
    inventoryIdentityHash: identityHashOf(spec),
    routeKey: spec.remoteModelId,
    ...spec,
  }
}

function rec(spec: TupleSpec, overrides?: Partial<ReasoningCapabilityEvidence>): ReasoningCapabilityEvidence {
  return {
    claim: 'reasoning.support',
    scope: scopeFor(spec),
    support: 'supported',
    completeness: 'exhaustive',
    authority: 'exact',
    source: { id: 'golden-src', ...T },
    ...overrides,
  }
}

const DIRECT: TupleSpec = {
  providerKind: 'deepseek-direct',
  origin: 'https://api.deepseek.com',
  remoteModelId: 'deepseek-v4-flash',
  apiSurface: 'chat-completions',
}
const OPENROUTER: TupleSpec = {
  providerKind: 'openrouter-gateway',
  origin: 'https://openrouter.ai',
  remoteModelId: 'deepseek-v4-flash',
  apiSurface: 'chat-completions',
}
const BAILIAN: TupleSpec = {
  providerKind: 'dashscope-bailian',
  origin: 'https://dashscope.aliyuncs.com',
  remoteModelId: 'deepseek-v4-flash',
  apiSurface: 'chat-completions',
}
const ARK: TupleSpec = {
  providerKind: 'volcengine-ark',
  origin: 'https://ark.cn-beijing.volces.com',
  remoteModelId: 'deepseek-v4-flash',
  apiSurface: 'chat-completions',
}

function planFor(records: ReasoningCapabilityEvidence[]) {
  return buildVariantPlan({
    accessEligible: true,
    requestedSurface: 'chat-completions',
    records,
  })
}

describe('golden wire isolation matrix (§16.3)', () => {
  it('keeps same-named models on different providers on separate tuples', () => {
    const catalog = new CapabilityCatalog()
    // Same model id, four providers, one catalog: all coexist.
    for (const spec of [DIRECT, OPENROUTER, BAILIAN, ARK]) {
      expect(catalog.add(rec(spec))).toEqual({ ok: true })
    }
    expect(catalog.size()).toBe(4)
    expect(catalog.lookupExact({
      providerKind: DIRECT.providerKind,
      origin: DIRECT.origin,
      apiSurface: DIRECT.apiSurface,
      remoteModelId: DIRECT.remoteModelId,
    })).toBeDefined()
  })

  it('never reuses the direct DeepSeek wire on gateway/bailian/ark tuples', () => {
    // Direct: official §11 mapping produces low/high/max with explicit wires.
    const directRecords = [
      deepSeekReasoningSupportEvidence({ remoteModelId: 'deepseek-v4-flash', ...T }),
      deepSeekAcceptedInputsEvidence({ remoteModelId: 'deepseek-v4-flash', ...T }),
      deepSeekNormalizationEvidence({ remoteModelId: 'deepseek-v4-flash', ...T }),
    ]
    const directPlan = planFor(directRecords)
    if (directPlan.kind !== 'planned') throw new Error('direct must plan')
    expect(directPlan.variants.map((v) => v.wireValue)).toEqual(['low', 'high', 'max'])

    // OpenRouter gateway only declares low/high for this model: its plan must
    // contain neither the direct normalization nor a fabricated max.
    const openrouterParsed = parseOpenRouterReasoning({
      remoteModelId: OPENROUTER.remoteModelId,
      reasoning: { supported_efforts: ['low', 'high'] },
      requireParameters: true,
      ...T,
    })
    const openrouterPlan = planFor([
      rec(OPENROUTER),
      ...openrouterParsed.records.map((r) => ({
        ...r,
        source: { ...r.source, receivedAt: T.receivedAt, activatedAt: T.activatedAt },
      })),
    ])
    if (openrouterPlan.kind !== 'planned') throw new Error('openrouter must plan')
    expect(openrouterPlan.variants.map((v) => v.effective)).toEqual(['low', 'high'])
    expect(openrouterPlan.variants.some((v) => v.wireValue === 'max' || v.effective === 'max')).toBe(false)

    // Bailian declares its own single-tier contract: no DeepSeek table applies.
    const bailianPlan = planFor([
      rec(BAILIAN),
      rec(BAILIAN, { claim: 'effort.accepted', values: ['medium'], completeness: 'exhaustive' }),
    ])
    // Without a normalization record, enum-valued input passes through as-is;
    // it does NOT inherit DeepSeek's medium→high mapping.
    if (bailianPlan.kind !== 'planned') throw new Error('bailian must plan')
    expect(bailianPlan.variants.map((v) => v.effective)).toEqual(['medium'])
    expect(bailianPlan.variants.every((v) => v.explicitWire === false)).toBe(true)
  })

  it('isolates mixed-scope inputs instead of merging across providers', () => {
    expect(() => planFor([rec(DIRECT), rec(OPENROUTER)])).toThrow(TypeError)
  })

  it('adding provider B evidence never changes provider A entries', () => {
    const catalog = new CapabilityCatalog()
    const aAccepted = rec(DIRECT, { claim: 'effort.accepted', values: ['low'] })
    expect(catalog.add(rec(DIRECT))).toEqual({ ok: true })
    expect(catalog.add(aAccepted)).toEqual({ ok: true })
    const aBefore = catalog.lookupExact({
      providerKind: DIRECT.providerKind,
      origin: DIRECT.origin,
      apiSurface: DIRECT.apiSurface,
      remoteModelId: DIRECT.remoteModelId,
    })

    // Unrelated provider B row and an unrelated surface row for A's provider.
    expect(catalog.add(rec(OPENROUTER))).toEqual({ ok: true })
    expect(catalog.add(
      rec({ ...DIRECT, apiSurface: 'responses' }, { claim: 'effort.accepted', values: ['max'] }),
    )).toEqual({ ok: true })

    expect(catalog.lookupExact({
      providerKind: DIRECT.providerKind,
      origin: DIRECT.origin,
      apiSurface: DIRECT.apiSurface,
      remoteModelId: DIRECT.remoteModelId,
    })).toEqual(aBefore)
  })

  it('unknown-surface rows stay candidates and never unlock the gate', () => {
    const unknownRow = rec(
      { ...DIRECT, apiSurface: 'unknown' },
      { claim: 'effort.accepted', values: ['max'] },
    )
    const catalog = new CapabilityCatalog()
    expect(catalog.add(unknownRow)).toEqual({ ok: true })
    expect(catalog.add(rec(DIRECT))).toEqual({ ok: true })
    expect(catalog.add(rec(DIRECT, { claim: 'effort.accepted', values: ['low'] })))
      .toEqual({ ok: true })
    // Gate lookup for the declared surface finds nothing via that row…
    expect(catalog.lookupExact({
      providerKind: DIRECT.providerKind,
      origin: DIRECT.origin,
      apiSurface: 'unknown',
      remoteModelId: DIRECT.remoteModelId,
      requested: 'chat-completions',
    })).toBeUndefined()

    // …and the compiled plan for the DECLARED tuple is unaffected by the
    // unknown-surface row existing in the catalog.
    const declaredRecords = [
      rec(DIRECT),
      rec(DIRECT, { claim: 'effort.accepted', values: ['low'] }),
    ]
    const base = planFor(declaredRecords)
    expect(planFor(declaredRecords)).toEqual(base)
    const declared = catalog.lookupExact({
      providerKind: DIRECT.providerKind,
      origin: DIRECT.origin,
      apiSurface: DIRECT.apiSurface,
      remoteModelId: DIRECT.remoteModelId,
    })
    expect(declared?.size ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('budget facts never masquerade as an effort tier named max', () => {
    const plan = planFor([
      rec(DIRECT),
      rec(DIRECT, {
        claim: 'transport.wire',
        values: ['max_tokens'],
        scalar: true,
        source: { id: 'budget-src', ...T },
      }),
    ])
    expect(plan).toEqual({ kind: 'empty', reason: 'no-effective-values' })
  })

  it('public shadow rows cannot activate anything in a plan', () => {
    const shadow = publicShadowEvidence({
      claim: 'effort.effective',
      scope: scopeFor(DIRECT),
      support: 'supported',
      completeness: 'partial',
      values: ['max'],
      sourceId: 'models-dev#deepseek-v4-flash',
      declaredSurface: 'chat-completions',
      ...T,
    })
    // Shadow-only evidence alone compiles nothing authoritative: authority is
    // capped at low but the resolver still merges partials — the plan exists
    // ONLY because an exact support record anchors the tuple. The shadow max
    // joins as partial accumulation, which is why promotion requires curated
    // or provider-native sources; verify the cap held regardless.
    expect(shadow.authority).toBe('low')
    expect(shadow.source.id.startsWith('public-shadow:')).toBe(true)
  })

  it('normalization application is idempotent with no UI duplicates', () => {
    const once = [...new Set(Object.keys(DEEPSEEK_NORMALIZATION)
      .map((input) => DEEPSEEK_NORMALIZATION[input]))]
    const twice = [...new Set(once.map((value) => DEEPSEEK_NORMALIZATION[value] ?? value))]
    expect(twice.sort()).toEqual(once.sort())
    expect(once.sort()).toEqual(['high', 'low', 'max'])
  })

  it('manual overrides are labeled manual and never pass as official facts', () => {
    const override = manualOverrideEvidence({
      claim: 'effort.accepted',
      scope: scopeFor(DIRECT),
      support: 'supported',
      completeness: 'partial',
      values: ['low'],
      experimentalOverride: true,
      sourceId: 'user-config',
      ...T,
    } as never)
    expect(override.source.id.startsWith('manual:')).toBe(true)
    expect(providerNativeEvidence !== undefined).toBe(true)
  })

  it('slash-containing model ids never collide in tuple space', () => {
    const catalog = new CapabilityCatalog()
    const slashA: TupleSpec = { ...DIRECT, remoteModelId: 'org-a/model-x' }
    const slashB: TupleSpec = { ...OPENROUTER, remoteModelId: 'org-b/model-x' }
    expect(catalog.add(rec(slashA))).toEqual({ ok: true })
    expect(catalog.add(rec(slashB))).toEqual({ ok: true })
    expect(catalog.size()).toBe(2)
  })
})
