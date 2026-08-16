import { describe, it, expect } from 'vitest'
import {
  effortConsensus,
  toggleConsensus,
  budgetConsensus,
  resolveCapabilityConsensus,
} from '../src/reasoning/consensus'
import type { ReasoningOption } from '../src/reasoning/types'

function md(reasoning: boolean, options: ReasoningOption[]) {
  return { metadata: { reasoning, options } }
}

describe('effort consensus', () => {
  it('Consensus-1: identical sets yield the same set', () => {
    const values = effortConsensus([
      { values: ['low', 'medium', 'high'] },
      { values: ['low', 'medium', 'high'] },
    ])
    expect(values).toEqual(['low', 'medium', 'high'])
  })

  it('Consensus-2: superset and subset yield the intersection', () => {
    const values = effortConsensus([
      { values: ['none', 'low', 'medium', 'high', 'xhigh'] },
      { values: ['low', 'medium', 'high'] },
    ])
    expect(values).toEqual(['low', 'medium', 'high'])
  })

  it('Consensus-3: partial overlap yields the common values', () => {
    const values = effortConsensus([
      { values: ['high', 'max'] },
      { values: ['low', 'medium', 'high'] },
    ])
    expect(values).toEqual(['high'])
  })

  it('empty intersection yields undefined', () => {
    expect(effortConsensus([{ values: ['low'] }, { values: ['high'] }])).toBeUndefined()
    expect(effortConsensus([])).toBeUndefined()
  })
})

describe('toggle and budget consensus', () => {
  it('toggle requires every candidate to declare it', () => {
    expect(toggleConsensus([{ hasToggle: true }, { hasToggle: true }])).toBe(true)
    expect(toggleConsensus([{ hasToggle: true }, { hasToggle: false }])).toBe(false)
    expect(toggleConsensus([])).toBe(false)
  })

  it('budget uses max-of-mins and min-of-maxes', () => {
    const budget = budgetConsensus([
      { min: 1024, max: 32768, hasBudget: true },
      { min: 2048, max: 16384, hasBudget: true },
      { min: 1024, max: 32000, hasBudget: true },
    ])
    expect(budget).toEqual({ min: 2048, max: 16384 })
  })

  it('budget is invalid when a candidate has no budget', () => {
    expect(budgetConsensus([
      { min: 1024, max: 32768, hasBudget: true },
      { min: 0, max: 0, hasBudget: false },
    ])).toBeUndefined()
  })

  it('budget is invalid when min > max after intersection', () => {
    expect(budgetConsensus([
      { min: 30000, max: 32768, hasBudget: true },
      { min: 1024, max: 2048, hasBudget: true },
    ])).toBeUndefined()
  })
})

describe('resolveCapabilityConsensus', () => {
  it('Consensus-4: effort + budget-only candidates share no common semantic', () => {
    const result = resolveCapabilityConsensus([
      md(true, [{ type: 'effort', values: ['low', 'high'] }]),
      md(true, [{ type: 'budget_tokens', min: 1024, max: 32768 }]),
    ])
    // effort not present in all candidates -> no effort; budget not in all -> no budget.
    expect(result.options).toEqual([])
  })

  it('Consensus-5: a missing candidate yields unresolved', () => {
    const result = resolveCapabilityConsensus([
      { metadata: { reasoning: true, options: [{ type: 'effort', values: ['low', 'high'] }] } },
      { metadata: undefined },
    ])
    expect(result.options).toEqual([])
    expect(result.allCandidatesKnown).toBe(false)
  })

  it('combines effort + toggle + budget when all candidates agree', () => {
    const result = resolveCapabilityConsensus([
      md(true, [
        { type: 'effort', values: ['low', 'medium', 'high'] },
        { type: 'toggle' },
        { type: 'budget_tokens', min: 1024, max: 32768 },
      ]),
      md(true, [
        { type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] },
        { type: 'toggle' },
        { type: 'budget_tokens', min: 2048, max: 64000 },
      ]),
    ])
    expect(result.options).toEqual([
      { type: 'effort', values: ['low', 'medium', 'high'] },
      { type: 'toggle' },
      { type: 'budget_tokens', min: 2048, max: 32768 },
    ])
    expect(result.allCandidatesKnown).toBe(true)
  })
})
