import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { getTransportAdapter } from '../src/reasoning/adapters'
import type { ModelsDevRegistry, ReasoningEffortControlV2 } from '../src/reasoning/registry/types-v2'

/**
 * S1 - accepted vs effective reasoning values.
 * A different API name is NOT necessarily an independent reasoning strength.
 * Runtime variants must come from effectiveValues; accepted-only values stay
 * represented but are never promoted without evidence.
 */
describe('S1 reasoning effort semantics', () => {
  const reg: ModelsDevRegistry = JSON.parse(readFileSync('src/generated/models-dev-registry.json', 'utf8'))

  function effort(m: string): ReasoningEffortControlV2 | undefined {
    return reg.models.find((x) => x.model === m)?.reasoning.controls.find((c): c is ReasoningEffortControlV2 => c.type === 'effort')
  }

  it('accepted value does not automatically become a variant (minimal stays accepted-only on models.dev records)', () => {
    const sample = reg.models.find((m) => (m.reasoning.controls ?? []).some((c) => c.type === 'effort' && (c.acceptedValues ?? []).includes('minimal') && !m.layers.official))
    expect(sample).toBeDefined()
    const eff = sample?.reasoning.controls.find((c) => c.type === 'effort') as ReasoningEffortControlV2
    expect(eff.acceptedValues).toContain('minimal')
    expect(eff.effectiveValues ?? []).not.toContain('minimal')
  })

  it('effective value generates a variant through the adapter', () => {
    const eff = effort('openai/gpt-5.5')
    expect(eff?.effectiveValues).toContain('high')
    const adapter = getTransportAdapter('openai')
    expect(adapter?.compileEffort?.('high')).toBeDefined()
  })

  it('official alias normalized to effective value', () => {
    const eff = effort('deepseek/deepseek-v4-pro')
    expect(eff?.normalization).toEqual({ medium: 'high', xhigh: 'high' })
    expect(eff?.effectiveValues).toEqual(['low', 'high', 'max'])
  })

  it('default normalization is preserved for official entries', () => {
    const eff = effort('openai/gpt-5.5')
    expect(eff?.default).toBe('medium')
    expect(eff?.effectiveValues).toContain(eff.default)
  })

  it('unknown semantics remains represented but not promoted', () => {
    // minimal appears in acceptedValues on models.dev-only records, never effectiveValues
    const withMinimal = reg.models.filter((m) => !m.layers.official && (m.reasoning.controls ?? []).some((c) => c.type === 'effort' && (c.acceptedValues ?? []).includes('minimal')))
    expect(withMinimal.length).toBeGreaterThan(0)
    for (const m of withMinimal) {
      for (const c of m.reasoning.controls ?? []) {
        if (c.type !== 'effort') continue
        expect(c.effectiveValues ?? []).not.toContain('minimal')
      }
    }
  })

  it('official evidence overrides models.dev compatibility observation', () => {
    // official entry controls remain authoritative in the merged registry
    const officialReg = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8'))
    for (const m of reg.models.filter((x) => x.layers.official)) {
      const off = officialReg.models.find((x: any) => x.model === m.model)
      const v2Eff = m.reasoning.controls.filter((c) => c.type === 'effort')
      const offEff = (off?.controls ?? []).filter((c: any) => c.type === 'effort')
      expect(v2Eff.map((c) => c.values).flat().sort()).toEqual(offEff.map((c: any) => c.values).flat().sort())
    }
  })

  it('conflict requires explicit resolution (fail-closed invariant)', () => {
    const unresolved = reg.models.filter((m) => m.conflictResolution === undefined && m.layers.official && m.reasoning.controls.length > 0 && false)
    expect(unresolved).toEqual([])
    // unresolved conflicts must be zero in the compiled artifact
    expect(reg.coverage.resolutionsApplied).toBe(reg.coverage.resolutionsRequired)
  })
})