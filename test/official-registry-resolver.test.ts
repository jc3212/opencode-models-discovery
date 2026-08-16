import { describe, it, expect } from 'vitest'
import { resolveOfficialModelCapability } from '../src/reasoning/registry/resolver'
import { loadRegistry } from '../src/reasoning/registry/loader'
import { REGISTRY_SCHEMA_VERSION } from '../src/reasoning/registry/types'
import type { ReasoningRegistry } from '../src/reasoning/registry/types'

function makeRegistry(models: Array<Record<string, unknown>> = []): ReasoningRegistry {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    registryVersion: '2026.08.16.1',
    models: models.map((m) => ({
      model: 'x',
      reasoning: true,
      controls: [{ type: 'effort', values: ['low', 'high'] }],
      sources: [{ type: 'official-doc', vendor: 'openai', verifiedAt: '2026-08-16' }],
      updatedAt: '2026-08-16',
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      ...m,
    })),
  }
}

const registry = loadRegistry(makeRegistry([
  { model: 'openai/gpt-5.4', aliases: ['gpt-5.4'], controls: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] }] },
  { model: 'openai/gpt-5.4-mini', aliases: ['gpt-5.4-mini'], controls: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
  { model: 'google/gemini-3.1-pro-preview', aliases: ['gemini-3.1-pro-preview'], controls: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
  { model: 'deepseek/deepseek-v4-pro', aliases: ['deepseek-v4-pro'], controls: [{ type: 'effort', values: ['low', 'high', 'max'], aliases: { medium: 'high', xhigh: 'high' } }], revision_alias: true },
]))!

describe('official registry resolver (design §53, §14-15)', () => {
  it('resolves an exact canonical id', () => {
    const match = resolveOfficialModelCapability('openai/gpt-5.4', registry)
    expect(match?.source).toBe('registry-exact')
    expect(match?.capability.controls[0]).toMatchObject({ values: ['none', 'low', 'medium', 'high', 'xhigh'] })
  })

  it('resolves a registry alias', () => {
    const match = resolveOfficialModelCapability('gpt-5.4', registry)
    expect(match?.source).toBe('registry-alias')
    expect(match?.capability.model).toBe('openai/gpt-5.4')
  })

  it('honors user aliases mapping to canonical ids', () => {
    const match = resolveOfficialModelCapability('vip-gpt', registry, { aliases: { 'vip-gpt': 'openai/gpt-5.4' } })
    expect(match?.source).toBe('registry-exact')
    expect(match?.capability.model).toBe('openai/gpt-5.4')
  })

  it('resolves a safe revision suffix only when revision_alias is declared', () => {
    const withRevision = resolveOfficialModelCapability('deepseek-v4-pro-2026-08-01', registry)
    expect(withRevision?.source).toBe('registry-revision')
    expect(withRevision?.capability.model).toBe('deepseek/deepseek-v4-pro')

    // gpt-5.4 does NOT declare revision_alias -> no revision match.
    expect(resolveOfficialModelCapability('gpt-5.4-2026-08-01', registry)).toBeUndefined()
  })

  it('never matches a whole family (design §14)', () => {
    expect(resolveOfficialModelCapability('gpt-anything', registry)).toBeUndefined()
    expect(resolveOfficialModelCapability('claude-opus-4-6', registry)).toBeUndefined()
    expect(resolveOfficialModelCapability('gemini-3-flash', registry)).toBeUndefined()
  })

  it('returns undefined for unknown models', () => {
    expect(resolveOfficialModelCapability('custom-ai-9000', registry)).toBeUndefined()
  })

  it('returns undefined when no registry is loaded', () => {
    expect(resolveOfficialModelCapability('gpt-5.4', undefined)).toBeUndefined()
  })
})

describe('per-model precision (design §69-70)', () => {
  it('different Gemini models produce different variants (no family sharing)', () => {
    const a = resolveOfficialModelCapability('gemini-3.1-pro-preview', registry)
    expect(a?.capability.controls[0]).toMatchObject({ values: ['low', 'medium', 'high'] })
    // A different Gemini model is NOT auto-inherited.
    expect(resolveOfficialModelCapability('gemini-3.5-flash', registry)).toBeUndefined()
  })

  it('version upgrades are independent', () => {
    const v1 = resolveOfficialModelCapability('gpt-5.4', registry)
    const v2 = resolveOfficialModelCapability('gpt-5.4-mini', registry)
    expect(v1?.capability.controls[0]).not.toEqual(v2?.capability.controls[0])
  })
})

describe('effective vs accepted values (design §7)', () => {
  it('keeps effective values with aliases separate', () => {
    const match = resolveOfficialModelCapability('deepseek-v4-pro', registry)
    const control = match?.capability.controls[0]
    expect(control).toMatchObject({
      values: ['low', 'high', 'max'],
      aliases: { medium: 'high', xhigh: 'high' },
    })
  })
})
