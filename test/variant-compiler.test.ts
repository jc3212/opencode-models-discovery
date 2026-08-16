import { describe, it, expect } from 'vitest'
import { compileReasoningVariants } from '../src/reasoning/compiler'
import { getTransportAdapter } from '../src/reasoning/adapters'
import type { ReasoningOption } from '../src/reasoning/types'

describe('effort variant compiler', () => {
  it('preserves the metadata effort set exactly for openai-compatible', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const result = compileReasoningVariants({
      capabilityOptions: options,
      transport: 'openai-compatible-effort',
    })
    expect(result.variants).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    })
  })

  it('does not invent none/minimal/xhigh/max', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'medium', 'high'] }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'openai-compatible-effort' })
    expect(Object.keys(result.variants)).toEqual(['low', 'medium', 'high'])
  })

  it('maps none effort to a none variant id', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['none', 'low', 'high'] }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'openai-compatible-effort' })
    expect(result.variants.none).toEqual({ reasoningEffort: 'none' })
  })

  it('compiles openrouter effort into the reasoning.effort shape', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['high', 'xhigh'] }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'openrouter' })
    expect(result.variants).toEqual({
      high: { reasoning: { effort: 'high' } },
      xhigh: { reasoning: { effort: 'xhigh' } },
    })
  })

  it('compiles google effort into thinkingConfig shape', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'high'] }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'google' })
    expect(result.variants).toEqual({
      low: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } },
      high: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' } },
    })
  })

  it('compiles anthropic effort into the effort shape', () => {
    const options: ReasoningOption[] = [{ type: 'effort', values: ['low', 'high'] }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    expect(result.variants).toEqual({
      low: { effort: 'low' },
      high: { effort: 'high' },
    })
  })
})

describe('toggle variant compiler', () => {
  it('compiles dashscope toggle to none/high with enable_thinking', () => {
    const options: ReasoningOption[] = [{ type: 'toggle' }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'dashscope-chat' })
    expect(result.variants).toEqual({
      none: { enable_thinking: false },
      high: { enable_thinking: true },
    })
  })

  it('compiles alibaba toggle to camelCase enableThinking', () => {
    const options: ReasoningOption[] = [{ type: 'toggle' }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'alibaba-sdk' })
    expect(result.variants).toEqual({
      none: { enableThinking: false },
      high: { enableThinking: true },
    })
  })
})

describe('budget variant compiler', () => {
  it('caps budget at metadata max and safety ceiling', () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 32768 }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'dashscope-chat' })
    expect(result.variants.high).toEqual({ enable_thinking: true, thinking_budget: 16000 })
    expect(result.variants.max).toEqual({ enable_thinking: true, thinking_budget: 32768 })
  })

  it('respects the output limit cap', () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', max: 32768 }]
    const result = compileReasoningVariants({
      capabilityOptions: options,
      transport: 'dashscope-chat',
      outputLimit: 16000,
    })
    // high collapses to the capped maximum when the output limit forces it.
    expect(result.variants.high).toEqual({ enable_thinking: true, thinking_budget: 15999 })
    expect(result.variants.max).toBeUndefined()
  })

  it('compiles openrouter budget to reasoning.max_tokens', () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 32768 }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'openrouter' })
    expect(result.variants.max).toEqual({ reasoning: { max_tokens: 32768 } })
  })

  it('does not invent a budget when metadata lacks a max and transport has no default', () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024 }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'openrouter' })
    expect(result.variants.max).toEqual({ reasoning: { max_tokens: 32768 } })
  })

  it('compiles anthropic budget into thinking.budgetTokens', () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 64000 }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    expect(result.variants.max).toEqual({ thinking: { type: 'enabled', budgetTokens: 32768 } })
  })

  it('compiles google budget into thinkingConfig.thinkingBudget', () => {
    const options: ReasoningOption[] = [{ type: 'budget_tokens', min: 1024, max: 32768 }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'google' })
    expect(result.variants.max).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingBudget: 32768 },
    })
  })
})

describe('anthropic and google toggle', () => {
  it('compiles anthropic toggle to thinking enabled/disabled', () => {
    const options: ReasoningOption[] = [{ type: 'toggle' }]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'anthropic' })
    expect(result.variants).toEqual({
      none: { thinking: { type: 'disabled' } },
      high: { thinking: { type: 'enabled' } },
    })
  })
})

describe('toggle + budget combination', () => {
  it('produces none/high/max for dashscope qwen', () => {
    const options: ReasoningOption[] = [
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 32768 },
    ]
    const result = compileReasoningVariants({ capabilityOptions: options, transport: 'dashscope-chat' })
    expect(result.variants).toEqual({
      none: { enable_thinking: false },
      high: { enable_thinking: true, thinking_budget: 16000 },
      max: { enable_thinking: true, thinking_budget: 32768 },
    })
    expect(result.warnings).toEqual([])
  })
})

describe('adapter registry', () => {
  it('resolves every supported transport to an adapter', () => {
    const transports = ['openai-compatible-effort', 'openrouter', 'dashscope-chat', 'anthropic', 'google', 'alibaba-sdk'] as const
    for (const t of transports) {
      expect(getTransportAdapter(t), t).toBeDefined()
    }
    expect(getTransportAdapter('unknown')).toBeUndefined()
  })
})
