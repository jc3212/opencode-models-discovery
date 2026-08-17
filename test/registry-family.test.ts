import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ModelsDevRegistry } from '../src/reasoning/registry/types-v2.ts'

describe('G4.5 family aggregation (evidence-driven, never guessed)', () => {
  const reg: ModelsDevRegistry = JSON.parse(readFileSync('src/generated/models-dev-registry.json', 'utf8'))
  const relations = JSON.parse(readFileSync('registry/evidence/base-models.json', 'utf8')).relations as Array<{
    model: string
    baseModel: string
  }>

  it('family is assigned only where a base-model identity relation exists', () => {
    const withFamily = reg.models.filter((m) => m.family !== undefined)
    expect(withFamily.length).toBe(relations.length)
    for (const m of withFamily) {
      expect(m.family).toBe(m.baseModel)
      expect(m.baseModel).toBeDefined()
    }
  })

  it('models without base relations have no family (no inferred family names)', () => {
    const without = reg.models.filter((m) => m.baseModel === undefined)
    expect(without.length).toBeGreaterThan(1000)
    for (const m of without) expect(m.family).toBeUndefined()
  })

  it('family is identity metadata, not a capability override', () => {
    const mini = reg.models.find((m) => m.model === 'openai/gpt-5.4-mini')
    expect(mini?.family).toBe('openai/gpt-5.4')
    expect(mini?.reasoning.supported).toBe(true)
    const official = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8'))
    const off = official.models.find((m: any) => m.model === 'openai/gpt-5.4-mini')
    expect(mini?.reasoning.controls.map((c: any) => c.values).sort()).toEqual(off.controls.map((c: any) => c.values).sort())
  })

  it('every family group refers to an existing canonical (aggregation target exists)', () => {
    const ids = new Set(reg.models.map((m) => m.model))
    for (const m of reg.models) {
      if (m.family) expect(ids.has(m.family)).toBe(true)
    }
  })
})
