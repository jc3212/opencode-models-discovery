import { describe, it, expect } from 'vitest'
import { validateRegistry } from '../src/reasoning/registry/validator'
import { loadRegistry, registryTestUtils } from '../src/reasoning/registry/loader'
import { REGISTRY_SCHEMA_VERSION } from '../src/reasoning/registry/types'
import type { ReasoningRegistry } from '../src/reasoning/registry/types'

function makeRegistry(overrides: Partial<ReasoningRegistry> = {}): ReasoningRegistry {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    registryVersion: '2026.08.16.1',
    models: [
      {
        model: 'openai/gpt-5.4',
        aliases: ['gpt-5.4'],
        reasoning: true,
        controls: [{ type: 'effort', values: ['none', 'low', 'medium', 'high', 'xhigh'], default: 'medium' }],
        sources: [{ type: 'official-doc', vendor: 'openai', verifiedAt: '2026-08-16' }],
        updatedAt: '2026-08-16',
        schemaVersion: REGISTRY_SCHEMA_VERSION,
      },
    ],
    ...overrides,
  }
}

describe('registry validator (design §33)', () => {
  it('accepts a valid registry', () => {
    expect(validateRegistry(makeRegistry()).valid).toBe(true)
  })

  it('rejects duplicate canonical ids', () => {
    const r = makeRegistry()
    r.models.push({ ...r.models[0]! })
    const result = validateRegistry(r)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('duplicate canonical id'))).toBe(true)
  })

  it('rejects effort default not in values', () => {
    const r = makeRegistry()
    r.models[0]!.controls = [{ type: 'effort', values: ['low', 'high'], default: 'medium' }]
    expect(validateRegistry(r).valid).toBe(false)
  })

  it('rejects effort alias target not in values', () => {
    const r = makeRegistry()
    r.models[0]!.controls = [{
      type: 'effort',
      values: ['low', 'high'],
      aliases: { medium: 'xhigh' },
    }]
    expect(validateRegistry(r).valid).toBe(false)
  })

  it('rejects budget min > max', () => {
    const r = makeRegistry()
    r.models[0]!.controls = [{ type: 'budget_tokens', min: 32768, max: 1024 }]
    expect(validateRegistry(r).valid).toBe(false)
  })

  it('rejects duplicate effort values', () => {
    const r = makeRegistry()
    r.models[0]!.controls = [{ type: 'effort', values: ['low', 'low'] }]
    expect(validateRegistry(r).valid).toBe(false)
  })

  it('rejects missing evidence', () => {
    const r = makeRegistry()
    r.models[0]!.sources = []
    expect(validateRegistry(r).valid).toBe(false)
  })

  it('rejects alias collisions with canonical ids', () => {
    const r = makeRegistry()
    r.models[0]!.aliases = ['openai/gpt-5.4']
    expect(validateRegistry(r).valid).toBe(false)
  })
})

describe('registry loader (design §29)', () => {
  it('loads a valid registry and rejects invalid ones', () => {
    expect(loadRegistry(makeRegistry())).toBeDefined()
    expect(loadRegistry({ schemaVersion: 999, registryVersion: 'x', models: [] })).toBeUndefined()
    expect(loadRegistry({ models: [] })).toBeUndefined()
    expect(loadRegistry(null)).toBeUndefined()
  })

  it('never breaks on a corrupt registry (fail-open)', () => {
    expect(loadRegistry({ models: [{ model: 'x' }] })).toBeUndefined()
  })
})

describe('registry effective-vs-accepted values (design §7)', () => {
  it('keeps effective values and records aliases separately', () => {
    const r = makeRegistry()
    r.models[0]!.controls = [{
      type: 'effort',
      values: ['low', 'high', 'max'],
      aliases: { medium: 'high', xhigh: 'max' },
    }]
    expect(validateRegistry(r).valid).toBe(true)
    const control = r.models[0]!.controls[0]!
    expect(control).toMatchObject({
      type: 'effort',
      values: ['low', 'high', 'max'],
      aliases: { medium: 'high', xhigh: 'max' },
    })
  })
})

describe('registry test utils', () => {
  it('installs a registry via test hook', () => {
    const reg = makeRegistry()
    registryTestUtils.setBundledRegistry(reg)
    // no throw
    registryTestUtils.setBundledRegistry(undefined)
  })
})
