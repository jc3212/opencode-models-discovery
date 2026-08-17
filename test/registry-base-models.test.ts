import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ModelsDevRegistry } from '../src/reasoning/registry/types-v2.ts'

describe('G4.3 base-model identity relations', () => {
  const reg: ModelsDevRegistry = JSON.parse(readFileSync('src/generated/models-dev-registry.json', 'utf8'))
  const relations = JSON.parse(readFileSync('registry/evidence/base-models.json', 'utf8')).relations as Array<{
    model: string
    baseModel: string
    confidence: string
  }>

  it('applies exactly the declared evidence relations (no fabrication)', () => {
    const withBase = reg.models.filter((m) => m.baseModel !== undefined)
    expect(withBase.length).toBe(relations.length)
    expect(reg.coverage.baseModelFromEvidence).toBe(relations.length)
    expect(reg.coverage.baseModelFromSnapshot).toBe(0) // models.dev 2026-08 has no base_model
    expect(reg.coverage.baseModelRelationsDeclared).toBe(relations.length)
  })

  it('every declared relation is present in the compiled registry', () => {
    for (const rel of relations) {
      const m = reg.models.find((x) => x.model === rel.model)
      expect(m?.baseModel).toBe(rel.baseModel)
    }
  })

  it('relations are exact canonical matches only (no glob/family matching)', () => {
    // a non-declared model must not carry a baseModel
    const undeclared = reg.models.find((m) => m.baseModel === undefined || !relations.some((r) => r.model === m.model))
    for (const m of reg.models) {
      if (!relations.some((r) => r.model === m.model)) expect(m.baseModel).toBeUndefined()
    }
    expect(undeclared).toBeDefined() // sanity: there are models without relations
  })

  it('baseModel never overrides reasoning capabilities (identity hint only)', () => {
    const mini = reg.models.find((m) => m.model === 'openai/gpt-5.4-mini')
    expect(mini?.baseModel).toBe('openai/gpt-5.4')
    // capability must still come from evidence/official layers, not the base
    expect(mini?.reasoning.supported).toBe(true)
    expect(mini?.layers.official).toBe(true)
  })

  it('declared relations reference existing models', () => {
    const ids = new Set(reg.models.map((m) => m.model))
    for (const rel of relations) {
      expect(ids.has(rel.model)).toBe(true)
    }
  })
})
