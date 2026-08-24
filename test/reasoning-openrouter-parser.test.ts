import { describe, expect, it } from 'vitest'

import { parseOpenRouterReasoning } from '../src/reasoning/openrouter-reasoning-parser'
import { CapabilityCatalog } from '../src/capabilities/catalog'
import type { ReasoningCapabilityEvidence } from '../src/capabilities/types'

const T = { receivedAt: '2026-08-24T00:00:00.000Z', activatedAt: '2026-08-24T00:00:00.000Z' }
const BASE = { remoteModelId: 'deepseek-v4-flash', ...T }

function claimsOf(records: ReasoningCapabilityEvidence[]) {
  return records.map((r) => r.claim).sort()
}

describe('parseOpenRouterReasoning', () => {
  it('treats a supported_efforts array as the exhaustive accepted set (max stays when explicit)', () => {
    const out = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { supported_efforts: ['low', 'high', 'max'] },
    })
    expect(out.diagnostics.selectorState).toBe('enumerable')
    const accepted = out.records.find((r) => r.claim === 'effort.accepted')
    expect(accepted?.values).toEqual(['low', 'high', 'max'])
    expect(accepted?.completeness).toBe('exhaustive')
  })

  it('records null as open-ended acceptance without inventing tiers', () => {
    const out = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { supported_efforts: null },
    })
    expect(out.diagnostics.selectorState).toBe('open-ended')
    const accepted = out.records.find((r) => r.claim === 'effort.accepted')
    expect(accepted?.completeness).toBe('unknown')
    expect(accepted?.values).toBeUndefined()
  })

  it('emits nothing for an omitted selector', () => {
    const out = parseOpenRouterReasoning({ ...BASE })
    expect(out.diagnostics.selectorState).toBe('omitted')
    expect(out.records).toEqual([])
  })

  it('drops non-string effort entries with a diagnostic count', () => {
    const out = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { supported_efforts: ['low', 42, null, 'high'] },
    })
    expect(out.diagnostics.droppedUnsupportedEffortValues).toBe(2)
    const accepted = out.records.find((r) => r.claim === 'effort.accepted')
    expect(accepted?.values).toEqual(['low', 'high'])
  })

  it('emits default and mandatory facts only when present', () => {
    const out = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { default_effort: 'high', mandatory: true },
    })
    expect(claimsOf(out.records)).toEqual(['effort.default', 'reasoning.mandatory'])
    expect(out.records.find((r) => r.claim === 'reasoning.mandatory')?.scalar).toBe(true)

    const absent = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { supported_efforts: ['low'] },
    })
    expect(claimsOf(absent.records)).toEqual(['effort.accepted'])
  })

  it('routes supports_max_tokens to transport.wire and never fabricates max effort', () => {
    const out = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { supports_max_tokens: true },
    })
    expect(claimsOf(out.records)).toEqual(['transport.wire'])
    const wire = out.records[0]
    expect(wire.values).toEqual(['max_tokens'])
    // No effort record exists at all → no fabricated `max`.
    expect(out.records.some((r) =>
      (r.values ?? []).includes('max') && r.claim === 'effort.accepted',
    )).toBe(false)
  })

  it('guards dynamic aliases that declare no exact controls', () => {
    const guardedOut = parseOpenRouterReasoning({
      remoteModelId: 'auto',
      reasoning: {},
      ...T,
    })
    expect(guardedOut.diagnostics.dynamicAliasGuarded).toBe(true)
    expect(guardedOut.records).toEqual([])

    // A dynamic alias WITH explicit declared controls still compiles.
    const declared = parseOpenRouterReasoning({
      remoteModelId: 'free',
      reasoning: { supported_efforts: ['low'] },
      ...T,
    })
    expect(declared.records.map((r) => r.claim)).toContain('effort.accepted')
  })

  it('marks best-effort delivery unless requireParameters is explicitly true', () => {
    const bestEffort = parseOpenRouterReasoning({
      ...BASE,
      reasoning: { supported_efforts: ['low'] },
    })
    expect(bestEffort.diagnostics.delivery).toBe('best-effort')
    expect(bestEffort.records[0].source.id).toContain('#best-effort#')

    const strict = parseOpenRouterReasoning({
      ...BASE,
      requireParameters: true,
      reasoning: { supported_efforts: ['low'] },
    })
    expect(strict.diagnostics.delivery).toBe('strict')
    expect(strict.records[0].source.id).toContain('#strict#')
  })

  it('produces catalog-valid records bound to the OpenRouter gateway tuple', () => {
    const out = parseOpenRouterReasoning({
      ...BASE,
      reasoning: {
        supported_efforts: ['low', 'high'],
        default_effort: 'high',
        mandatory: false,
        supports_max_tokens: true,
      },
    })
    const catalog = new CapabilityCatalog()
    for (const record of out.records) {
      expect(catalog.add(record)).toEqual({ ok: true })
      expect(record.scope.providerKind).toBe('openrouter-gateway')
      expect(record.scope.apiSurface).toBe('chat-completions')
    }
    expect(catalog.size()).toBe(1)
  })
})
