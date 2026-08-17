import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { classifyConflict } from '../scripts/registry-tools/compile-registry'
import type { OfficialReasoningCapability } from '../src/reasoning/registry/types.ts'
import type { ModelsDevRegistry } from '../src/reasoning/registry/types-v2.ts'

const OFFICIAL: OfficialReasoningCapability = {
  model: 'x/test',
  reasoning: true,
  controls: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
  sources: [],
  updatedAt: '2026-08-17',
  schemaVersion: 1,
}

function official(over: Partial<OfficialReasoningCapability> = {}): OfficialReasoningCapability {
  return { ...OFFICIAL, ...over }
}

describe('G4.2 evidence conflict classification', () => {
  it('official superset over models.dev -> compatible (no resolution needed)', () => {
    const r = classifyConflict(official(), true, [{ type: 'effort', values: ['low', 'medium'] }])
    expect(r.kind).toBe('compatible')
  })

  it('models.dev extra effort value -> md-extra (resolution required)', () => {
    const r = classifyConflict(official(), true, [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }])
    expect(r.kind).toBe('md-extra')
  })

  it('models.dev controls but official none -> md-controls-only', () => {
    const r = classifyConflict(official({ controls: [] }), true, [{ type: 'effort', values: ['high'] }])
    expect(r.kind).toBe('md-controls-only')
  })

  it('models.dev says reasoning=false but official true -> flag-conflict', () => {
    const r = classifyConflict(official(), false, [])
    expect(r.kind).toBe('flag-conflict')
  })

  it('official controls but models.dev none -> official-controls-only (compatible)', () => {
    const r = classifyConflict(official(), true, [])
    expect(r.kind).toBe('compatible')
  })
})

describe('G4.2 compiled models-dev registry (evidence merge)', () => {
  const reg: ModelsDevRegistry = JSON.parse(readFileSync('src/generated/models-dev-registry.json', 'utf8'))
  const officialReg = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8'))

  it('has schemaVersion 2, mdev-r version, GENERATED notice', () => {
    expect(reg.schemaVersion).toBe(2)
    expect(reg.registryVersion).toMatch(/^mdev-r[0-9a-f]{10}$/)
    expect(reg._notice).toContain('GENERATED')
    expect(reg.source.models).toBe('models.dev')
  })

  it('canonical model ids are unique', () => {
    const ids = reg.models.map((m) => m.model)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every conflicting model carries an explicit resolution (no silent overwrite)', () => {
    const needing = reg.models.filter((m) =>
      // flag-conflict and md-* are the kinds that required a resolution
      m.conflictResolution !== undefined,
    )
    expect(needing.length).toBe(reg.coverage.resolutionsApplied)
    expect(reg.coverage.resolutionsApplied).toBe(reg.coverage.resolutionsRequired)
    for (const m of needing) {
      expect(m.conflictResolution?.prefer).toBe('official-exact')
    }
  })

  it('official controls are authoritative: overlap models keep official controls untouched', () => {
    const officialByModel = new Map(officialReg.models.map((m: any) => [m.model, m]))
    for (const m of reg.models) {
      if (!m.layers.official) continue
      const officialEntry = officialByModel.get(m.model)
      expect(m.reasoning.supported).toBe(officialEntry.reasoning)
      // S1: v2 controls carry accepted/effective semantics; values remain equal to official.
      const eff = m.reasoning.controls.filter((c: any) => c.type === 'effort')
      expect(eff.map((c: any) => c.values).sort()).toEqual(officialEntry.controls.filter((c: any) => c.type === 'effort').map((c: any) => c.values).sort())
      for (const c of eff) expect(c.effectiveValues).toEqual(c.values)
      // evidence must include an official source
      expect(m.evidence.some((e) => e.id.startsWith('official/'))).toBe(true)
    }
  })

  it('no silent drop: every official model is present, every reasoning=true official overlap is accounted', () => {
    const ids = new Set(reg.models.map((m) => m.model))
    for (const m of officialReg.models) expect(ids.has(m.model)).toBe(true)
    const officialReasoning = officialReg.models.filter((m: any) => m.reasoning === true)
    for (const m of officialReasoning) {
      const v2 = reg.models.find((x) => x.model === m.model)
      expect(v2?.reasoning.supported).toBe(true)
    }
  })

  it('models.dev-only records carry models-dev evidence and no official layer', () => {
    const only = reg.models.filter((m) => m.layers.modelsDev && !m.layers.official)
    expect(only.length).toBeLessThanOrEqual(reg.coverage.reasoningTrue)
    for (const m of only) {
      expect(m.evidence.some((e) => e.type === 'models-dev')).toBe(true)
    }
  })
})