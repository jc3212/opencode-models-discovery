import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveSafeCanonicalization, isSemanticSuffix } from '../src/reasoning/identity/safe-canonicalization'
import type { ModelsDevRegistry } from '../src/reasoning/registry/types-v2'

describe('G5 safe canonicalization', () => {
  const reg: ModelsDevRegistry = JSON.parse(readFileSync('src/generated/models-dev-registry.json', 'utf8'))
  const canonicals = reg.models.map((m) => m.model)

  it('resolves a unique date-suffix model to its unique canonical base', () => {
    const r = resolveSafeCanonicalization('claude-haiku-4-5-20260817', canonicals)
    expect(r.resolved).toBe(true)
    if (r.resolved) {
      expect(r.canonical).toBe('anthropic/claude-haiku-4-5')
      expect(r.match).toBe('safe-canonicalization')
      expect(r.confidence).toBe('high')
      expect(r.suffix).toBe('-20260817')
    }
  })

  it('does not resolve when the suffix is semantic (latest/free/coder/etc)', () => {
    for (const id of ['glm-5.2-free', 'ark-code-latest', 'grok-420-fast', 'kimi-k3-free']) {
      const r = resolveSafeCanonicalization(id, canonicals)
      expect(r.resolved).toBe(false)
    }
  })

  it('does not resolve multi-candidate names (claude-opus-4.7 dot vs dash)', () => {
    const r = resolveSafeCanonicalization('claude-opus-4.7', canonicals)
    expect(r.resolved).toBe(false)
  })

  it('does not resolve unknown suffixes', () => {
    const r = resolveSafeCanonicalization('minimax-m2.7', canonicals)
    expect(r.resolved).toBe(false)
  })

  it('semantic suffix guard list is explicit', () => {
    expect(isSemanticSuffix('latest')).toBe(true)
    expect(isSemanticSuffix('free')).toBe(true)
    expect(isSemanticSuffix('thinking')).toBe(true)
    expect(isSemanticSuffix('20251001')).toBe(false)
  })
})
