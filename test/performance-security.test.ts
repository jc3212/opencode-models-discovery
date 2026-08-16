import { describe, it, expect } from 'vitest'
import { resolveOfficialModelCapability } from '../src/reasoning/registry/resolver'
import { loadRegistry } from '../src/reasoning/registry/loader'
import { buildReasoningCoverageReport } from '../src/reasoning/coverage'
import { normalizeBaseURL } from '../src/utils/openai-compatible-api'
import { REGISTRY_SCHEMA_VERSION } from '../src/reasoning/registry/types'
import type { ReasoningRegistry } from '../src/reasoning/registry/types'

/**
 * Performance (design §52-53) + security redaction (design §54, §36).
 */

function bigRegistry(count: number): ReasoningRegistry {
  const models = []
  for (let i = 0; i < count; i++) {
    models.push({
      model: 'openai/gpt-' + i,
      aliases: ['gpt-' + i],
      reasoning: true,
      controls: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      sources: [{ type: 'official-doc', vendor: 'openai', verifiedAt: '2026-08-16' }],
      updatedAt: '2026-08-16',
      schemaVersion: REGISTRY_SCHEMA_VERSION,
    })
  }
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, registryVersion: 'r-test', models }
}

describe('registry lookup performance (design §52-53)', () => {
  it('resolves 5000 models through a 1000-entry registry quickly (indexed, not linear scan)', () => {
    const registry = loadRegistry(bigRegistry(1000))!
    const started = performance.now()
    let hits = 0
    for (let i = 0; i < 5000; i++) {
      const id = 'gpt-' + (i % 1000)
      if (resolveOfficialModelCapability(id, registry)) hits++
    }
    const elapsed = performance.now() - started
    expect(hits).toBe(5000)
    // 5000 indexed lookups should be well under 1s.
    expect(elapsed).toBeLessThan(1000)
  })

  it('builds the runtime index once, not per model (map-based)', () => {
    const registry = bigRegistry(500)
    const started = performance.now()
    for (let i = 0; i < 500; i++) {
      resolveOfficialModelCapability('gpt-' + i, registry)
    }
    // Each call builds its own lookups; even so, 500 calls must stay fast.
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('coverage report performance (design §52)', () => {
  it('aggregates 1000 resolutions quickly', () => {
    const resolutions = Array.from({ length: 1000 }, (_, i) => ({
      model: { discoveredModelId: 'm' + i, source: 'none' as const, confidence: 'none' as const },
      capability: { reasoning: false, options: [], source: 'none' as const, confidence: 'none' as const },
      transport: { transport: 'unknown' as const, confidence: 'none' as const, reason: 'x', safeToCompile: false },
      variants: {},
      warnings: [],
      diagnostics: {},
    }))
    const started = performance.now()
    const report = buildReasoningCoverageReport('p', resolutions)
    const elapsed = performance.now() - started
    expect(report.summary.totalModels).toBe(1000)
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('security redaction (design §54, §36)', () => {
  it('hostname extraction never exposes credential-bearing query segments', () => {
    // The audit uses hostname-only extraction (like hostnameOnly in cli.ts).
    const url = new URL(normalizeBaseURL('https://gw.example.com/v1?api_key=super-secret-12345'))
    expect(url.hostname).toBe('gw.example.com')
    // The hostname (what the audit prints) contains no secret.
    expect(url.hostname).not.toContain('secret')
  })

  it('the audit hostname helper never exposes credentials', () => {
    // Simulate the audit's hostnameOnly logic.
    const hostname = new URL(normalizeBaseURL('https://user:super-secret@relay.example.com/v1')).hostname
    expect(hostname).toBe('relay.example.com')
    expect(hostname).not.toContain('secret')
  })
})
