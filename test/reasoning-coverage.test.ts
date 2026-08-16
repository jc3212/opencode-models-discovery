import { describe, it, expect } from 'vitest'
import {
  buildReasoningCoverageReport,
  classifyReasoningEntry,
} from '../src/reasoning/coverage'
import type { ResolvedReasoning } from '../src/reasoning/types'

function makeResolution(overrides: Partial<ResolvedReasoning> = {}): ResolvedReasoning {
  return {
    model: { discoveredModelId: 'gpt-test', canonicalModelId: 'openai/gpt-test', source: 'exact', confidence: 'exact' },
    capability: {
      reasoning: true,
      options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      source: 'models.dev',
      confidence: 'high',
    },
    transport: {
      transport: 'openai-compatible-effort',
      confidence: 'exact',
      reason: 'explicit-config',
      safeToCompile: true,
    },
    variants: {
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    },
    warnings: [],
    diagnostics: {},
    ...overrides,
  }
}

describe('reasoning coverage classification', () => {
  it('classifies a wire-verified transport as VERIFIED', () => {
    const entry = classifyReasoningEntry('prov', makeResolution())
    expect(entry.status).toBe('VERIFIED')
    expect(entry.capabilityStatus).toBe('resolved')
    expect(entry.transportStatus).toBe('verified')
    expect(entry.variants).toEqual(['low', 'medium', 'high'])
  })

  it('classifies a non-verified but resolved transport as RESOLVED', () => {
    const entry = classifyReasoningEntry('prov', makeResolution({
      transport: { transport: 'anthropic', confidence: 'exact', reason: 'explicit-config', safeToCompile: true },
    }))
    expect(entry.status).toBe('RESOLVED')
    expect(entry.transportStatus).toBe('resolved')
  })

  it('classifies unknown transport as TRANSPORT_UNKNOWN with no variants', () => {
    const entry = classifyReasoningEntry('prov', makeResolution({
      transport: { transport: 'unknown', confidence: 'none', reason: 'host-api-surface-unresolved', safeToCompile: false },
      variants: {},
    }))
    expect(entry.status).toBe('TRANSPORT_UNKNOWN')
    expect(entry.reasoningKnown).toBe(true)
    expect(entry.capabilityStatus).toBe('resolved')
    expect(entry.transportStatus).toBe('unknown')
    expect(entry.variants).toEqual([])
  })

  it('classifies missing capability as CAPABILITY_UNKNOWN', () => {
    const entry = classifyReasoningEntry('prov', makeResolution({
      capability: { reasoning: true, options: [], source: 'none', confidence: 'none' },
      variants: {},
    }))
    expect(entry.status).toBe('CAPABILITY_UNKNOWN')
    expect(entry.reasoningKnown).toBe(false)
  })

  it('classifies a confirmed non-reasoning model as NOT_REASONING', () => {
    const entry = classifyReasoningEntry('prov', makeResolution({
      capability: { reasoning: false, options: [], source: 'none', confidence: 'none' },
      variants: {},
    }))
    expect(entry.status).toBe('NOT_REASONING')
  })

  it('honors explicit wireVerified override', () => {
    const entry = classifyReasoningEntry('prov', makeResolution({
      transport: { transport: 'google', confidence: 'exact', reason: 'explicit-config', safeToCompile: true },
    }), { wireVerified: true })
    expect(entry.status).toBe('VERIFIED')
  })
})

describe('reasoning coverage report', () => {
  it('aggregates summary across all statuses', () => {
    const report = buildReasoningCoverageReport('newapi-a', [
      makeResolution(), // VERIFIED
      makeResolution({ // VERIFIED too
        model: { discoveredModelId: 'qwen-x', canonicalModelId: 'alibaba/qwen-x', source: 'exact', confidence: 'exact' },
        capability: { reasoning: true, options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 32768 }], source: 'models.dev', confidence: 'high' },
        transport: { transport: 'dashscope-chat', confidence: 'exact', reason: 'explicit-config', safeToCompile: true },
        variants: { none: { enable_thinking: false }, high: { enable_thinking: true, thinking_budget: 16000 }, max: { enable_thinking: true, thinking_budget: 32768 } },
      }),
      makeResolution({ // TRANSPORT_UNKNOWN
        model: { discoveredModelId: 'qwen-y', canonicalModelId: 'alibaba/qwen-y', source: 'exact', confidence: 'exact' },
        capability: { reasoning: true, options: [{ type: 'toggle' }], source: 'models.dev', confidence: 'high' },
        transport: { transport: 'unknown', confidence: 'none', reason: 'host-api-surface-unresolved', safeToCompile: false },
        variants: {},
      }),
      makeResolution({ // CAPABILITY_UNKNOWN
        model: { discoveredModelId: 'custom-ai-9000', source: 'none', confidence: 'none' },
        capability: { reasoning: true, options: [], source: 'none', confidence: 'none' },
        transport: { transport: 'unknown', confidence: 'none', reason: 'host-api-surface-unresolved', safeToCompile: false },
        variants: {},
      }),
      makeResolution({ // NOT_REASONING
        model: { discoveredModelId: 'embedding-model', source: 'none', confidence: 'none' },
        capability: { reasoning: false, options: [], source: 'none', confidence: 'none' },
        transport: { transport: 'unknown', confidence: 'none', reason: 'host-api-surface-unresolved', safeToCompile: false },
        variants: {},
      }),
    ])

    expect(report.summary).toMatchObject({
      providerId: 'newapi-a',
      totalModels: 5,
      reasoningModels: 3,
      verifiedModels: 2,
      resolvedModels: 0,
      capabilityUnknown: 1,
      transportUnknown: 1,
      notReasoning: 1,
      variantEnabledModels: 2,
    })
  })

  it('is a pure function returning fresh objects', () => {
    const a = buildReasoningCoverageReport('p', [makeResolution()])
    const b = buildReasoningCoverageReport('p', [makeResolution()])
    expect(a).toEqual(b)
    expect(a.entries).not.toBe(b.entries)
  })
})
