import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ModelsDevRegistry } from '../src/reasoning/registry/types-v2.ts'

describe('G4.4 relay alias identity resolution', () => {
  const reg: ModelsDevRegistry = JSON.parse(readFileSync('src/generated/models-dev-registry.json', 'utf8'))

  it('every model carries a valid identityResolution', () => {
    for (const m of reg.models) {
      expect(['vendor-known', 'anchor-match', 'unresolved']).toContain(m.identityResolution)
    }
  })

  it('official curated entries are vendor-known anchors with relay aliases absorbed', () => {
    const vk = reg.models.filter((m) => m.identityResolution === 'vendor-known')
    expect(vk.length).toBe(39)
    for (const m of vk) {
      expect(m.layers.official).toBe(true)
    }
    const withAlias = vk.filter((m) => (m.aliases?.length ?? 0) > 0)
    expect(withAlias.length).toBeGreaterThan(0)
    for (const m of withAlias) {
      expect(m.aliases?.every((a) => typeof a === 'string')).toBe(true)
      expect(new Set(m.aliases).size).toBe(m.aliases?.length)
    }
  })

  it('relay aliases resolve onto vendor anchors without guessing', () => {
    const am = reg.models.filter((m) => m.identityResolution === 'anchor-match')
    expect(am.length).toBeGreaterThan(100)
    for (const m of am) {
      const vendor = m.model.split('/')[0]
      expect(['openai', 'anthropic', 'google', 'deepseek', 'zai', 'xai', 'alibaba', 'moonshot']).toContain(vendor)
      expect(m.layers.official).toBe(false)
      expect(m.layers.modelsDev).toBe(true)
      expect(m.relayCount).toBeGreaterThanOrEqual((m.aliases?.length ?? 0) + 1)
      expect(new Set(m.aliases ?? []).size).toBe(m.aliases?.length ?? 0)
    }
    const kimi = reg.models.find((m) => m.model === 'moonshot/kimi-k2.7-code')
    expect(kimi?.identityResolution).toBe('anchor-match')
    expect((kimi?.aliases?.length ?? 0)).toBeGreaterThan(5)
  })

  it('unresolved keys stay on their own id with no fabricated canonical', () => {
    const un = reg.models.filter((m) => m.identityResolution === 'unresolved')
    expect(un.length).toBeGreaterThan(1000)
    for (const m of un) {
      expect(m.aliases).toBeUndefined()
      expect(m.relayCount).toBe(1)
      expect(m.baseModel).toBeUndefined()
    }
  })

  it('alias identity never alters reasoning capabilities (identity-only)', () => {
    const gpt = reg.models.find((m) => m.model === 'openai/gpt-5.3-codex')
    expect(gpt?.aliases?.length).toBeGreaterThan(0)
    const official = JSON.parse(readFileSync('src/generated/reasoning-registry.json', 'utf8'))
    const offEntry = official.models.find((m: any) => m.model === 'openai/gpt-5.3-codex')
    expect(gpt?.reasoning.controls.map((c: any) => c.values).sort()).toEqual(offEntry.controls.map((c: any) => c.values).sort())
  })

  it('alias entries across the registry are unique (no duplicate relay bindings)', () => {
    const allAliases = new Set<string>()
    for (const m of reg.models) {
      for (const a of m.aliases ?? []) allAliases.add(m.model + '|' + a)
    }
    expect(allAliases.size).toBe(
      reg.models.reduce((n, m) => n + (m.aliases?.length ?? 0), 0),
    )
  })
})
