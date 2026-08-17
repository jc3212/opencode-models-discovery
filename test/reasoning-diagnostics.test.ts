import { describe, it, expect } from 'vitest'
import { formatReasoningDiagnostic, summarizeReasoningResolution } from '../src/reasoning/diagnostics'
import type { ResolvedReasoning } from '../src/reasoning/types'

function makeResolution(overrides: Partial<ResolvedReasoning> = {}): ResolvedReasoning {
  return {
    model: { discoveredModelId: 'qwen-x', canonicalModelId: 'alibaba/qwen-x', source: 'unique-model-id', confidence: 'high' },
    capability: {
      reasoning: true,
      options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 32768 }],
      source: 'models.dev',
      confidence: 'high',
    },
    transport: { transport: 'dashscope-chat', confidence: 'exact', reason: 'explicit-config', safeToCompile: true },
    variants: {
      none: { enable_thinking: false },
      high: { enable_thinking: true, thinking_budget: 16000 },
      max: { enable_thinking: true, thinking_budget: 32768 },
    },
    warnings: [],
    diagnostics: {},
    ...overrides,
  }
}

describe('reasoning diagnostics', () => {
  it('formats a successful Qwen resolution', () => {
    const line = formatReasoningDiagnostic(makeResolution())
    expect(line).toContain('model=qwen-x')
    expect(line).toContain('canonical=alibaba/qwen-x')
    expect(line).toContain('control=toggle+budget_tokens')
    expect(line).toContain('transport=dashscope-chat')
    expect(line).toContain('transportConfidence=exact')
    expect(line).toContain('variants=none,high,max')
  })

  it('marks inferred compatible forwarding as unverified', () => {
    const resolution = makeResolution({
      transport: {
        transport: 'openai-compatible-effort',
        confidence: 'medium',
        reason: 'official-model-openai-compatible-effort-inferred',
        safeToCompile: true,
      },
    })
    expect(formatReasoningDiagnostic(resolution)).toContain('relayForwarding=unverified')
    expect(summarizeReasoningResolution(resolution)).toMatchObject({
      transportConfidence: 'medium',
      relayForwarding: 'unverified',
    })
  })

  it('formats an unknown transport with variants=none', () => {
    const line = formatReasoningDiagnostic(makeResolution({
      transport: { transport: 'unknown', confidence: 'none', reason: 'host-api-surface-unresolved', safeToCompile: false },
      variants: {},
    }))
    expect(line).toContain('transport=unknown')
    expect(line).toContain('variants=none')
  })

  it('formats an ambiguous canonical match', () => {
    const line = formatReasoningDiagnostic(makeResolution({
      model: { discoveredModelId: 'model-x', source: 'unique-model-id', confidence: 'none', ambiguous: true },
      transport: { transport: 'unknown', confidence: 'none', reason: 'host-api-surface-unresolved', safeToCompile: false },
      variants: {},
    }))
    expect(line).toContain('canonical=unresolved')
    expect(line).toContain('reason=ambiguous-canonical-match')
  })

  it('summarizes into structured fields', () => {
    const summary = summarizeReasoningResolution(makeResolution())
    expect(summary).toMatchObject({
      model: 'qwen-x',
      canonical: 'alibaba/qwen-x',
      control: 'toggle+budget_tokens',
      transport: 'dashscope-chat',
      variants: ['none', 'high', 'max'],
    })
  })
})
