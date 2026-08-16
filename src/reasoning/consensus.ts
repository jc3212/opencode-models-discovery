import type { ReasoningOption } from './types'

/**
 * Safe capability consensus (design §19-24, §61).
 *
 * When a model id matches several plausible hosts with DIFFERENT
 * reasoning_options, we do not use the union and we do not pick one host.
 * Instead we compute the INTERSECTION - the controls every candidate
 * explicitly supports. A candidate with MISSING metadata is treated as
 * unknown, never as "unsupported": consensus then yields nothing.
 *
 * All functions here are pure and deterministic.
 */

export interface CapabilityConsensusResult {
  options: ReasoningOption[]
  /** True when every candidate had explicit metadata (no missing). */
  allCandidatesKnown: boolean
  warnings: string[]
}

/**
 * Computes the shared effort values across all candidates.
 * Empty (or any missing candidate) yields undefined -> no effort variants.
 */
export function effortConsensus(candidates: Array<{ values: string[] }>): string[] | undefined {
  if (candidates.length === 0) return undefined
  const base = candidates[0]!.values
  let result = base
  for (let i = 1; i < candidates.length; i++) {
    result = result.filter((v) => candidates[i]!.values.includes(v))
  }
  return result.length > 0 ? result : undefined
}

/** Whether every candidate explicitly declares a toggle. */
export function toggleConsensus(candidates: Array<{ hasToggle: boolean }>): boolean {
  return candidates.length > 0 && candidates.every((c) => c.hasToggle)
}

export interface BudgetCandidate {
  min?: number
  max?: number
  hasBudget: boolean
}

/**
 * Safe budget range: max of all mins .. min of all maxes.
 * Valid only when min <= max and every candidate declares a budget.
 */
export function budgetConsensus(candidates: BudgetCandidate[]): { min: number; max: number } | undefined {
  if (candidates.length === 0) return undefined
  if (!candidates.every((c) => c.hasBudget)) return undefined

  const mins = candidates.map((c) => c.min).filter((v): v is number => typeof v === 'number')
  const maxes = candidates.map((c) => c.max).filter((v): v is number => typeof v === 'number')
  if (mins.length !== candidates.length || maxes.length !== candidates.length) return undefined

  const min = Math.max(...mins)
  const max = Math.min(...maxes)
  if (!(min <= max)) return undefined
  return { min, max }
}

/**
 * Computes a consensus ReasoningCapability from per-host candidate metadata.
 *
 * Rules (design §22-24):
 * - Any candidate with missing reasoning metadata => unresolved.
 * - Effort uses intersection; empty intersection => no effort.
 * - Toggle requires every candidate to declare toggle.
 * - Budget requires every candidate to declare a budget and min <= max.
 */
export function resolveCapabilityConsensus(
  candidates: Array<{ metadata: { reasoning: boolean; options: ReasoningOption[] } | undefined }>,
): CapabilityConsensusResult {
  const warnings: string[] = []

  // Missing metadata in any candidate => unresolved (missing != unsupported).
  const known = candidates.filter((c) => c.metadata !== undefined)
  if (known.length !== candidates.length || candidates.length === 0) {
    warnings.push('consensus-unresolved-missing-candidate-metadata')
    return { options: [], allCandidatesKnown: false, warnings }
  }

  const allMetadata = known.map((c) => c.metadata!)

  // Only reasoning candidates participate.
  if (!allMetadata.every((m) => m.reasoning)) {
    warnings.push('consensus-unresolved-not-all-reasoning')
    return { options: [], allCandidatesKnown: true, warnings }
  }

  const options: ReasoningOption[] = []

  // Effort intersection.
  const effortCandidates = allMetadata
    .map((m) => m.options.find((o) => o.type === 'effort'))
    .filter((o): o is Extract<ReasoningOption, { type: 'effort' }> => o !== undefined)
  if (effortCandidates.length === allMetadata.length) {
    const values = effortConsensus(effortCandidates.map((o) => ({ values: o.values })))
    if (values) {
      options.push({ type: 'effort', values })
    } else {
      warnings.push('consensus-effort-intersection-empty')
    }
  } else {
    warnings.push('consensus-effort-missing-in-some-candidates')
  }

  // Toggle consensus.
  if (toggleConsensus(allMetadata.map((m) => ({ hasToggle: m.options.some((o) => o.type === 'toggle') })))) {
    options.push({ type: 'toggle' })
  }

  // Budget consensus.
  const budgetCandidates = allMetadata.map((m) => {
    const b = m.options.find((o): o is Extract<ReasoningOption, { type: 'budget_tokens' }> => o.type === 'budget_tokens')
    return { min: b?.min, max: b?.max, hasBudget: b !== undefined }
  })
  const budget = budgetConsensus(budgetCandidates)
  if (budget) {
    options.push({ type: 'budget_tokens', min: budget.min, max: budget.max })
  }

  return { options, allCandidatesKnown: true, warnings }
}
