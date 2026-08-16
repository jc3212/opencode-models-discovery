import type {
  ReasoningCompileResult,
  ReasoningOption,
  ReasoningTransportAdapter,
  ReasoningTransportType,
} from './types'
import { getTransportAdapter } from './adapters'

/**
 * Compiles normalized reasoning metadata + a resolved transport into OpenCode
 * model variants. Pure function: no network, no disk I/O, no discovery, no
 * model calls.
 *
 * Safety rules (design §24-27):
 * - effort: preserve the metadata value set exactly; never invent L/M/H.
 * - toggle: `none` / `high` (none = reasoning disabled, high = enabled).
 * - budget: `high` / `max`, capped by metadata max, output limit, and a
 *   safety ceiling. Never invent a huge budget from nothing.
 */

/** Conservative ceiling for an automatic max reasoning budget. */
const SAFETY_MAX_BUDGET = 32768
/** Conventional "high" reasoning budget used when metadata gives a range. */
const HIGH_BUDGET = 16000

export interface CompileReasoningVariantsInput {
  capabilityOptions: ReasoningOption[]
  transport: ReasoningTransportType
  outputLimit?: number
  adapter?: ReasoningTransportAdapter
}

function compileEffort(
  values: string[],
  adapter: ReasoningTransportAdapter,
  warnings: string[],
): Record<string, Record<string, unknown>> {
  const variants: Record<string, Record<string, unknown>> = {}
  for (const effort of values) {
    const id = effort === 'none' ? 'none' : effort
    const settings = adapter.compileEffort?.(effort)
    if (settings) {
      variants[id] = settings
    } else {
      warnings.push(`effort ${effort} unsupported by transport; skipped`)
    }
  }
  return variants
}

function compileBudget(
  option: Extract<ReasoningOption, { type: 'budget_tokens' }>,
  adapter: ReasoningTransportAdapter,
  outputLimit: number | undefined,
  warnings: string[],
): Record<string, Record<string, unknown>> {
  const ceiling = Math.min(option.max ?? SAFETY_MAX_BUDGET, SAFETY_MAX_BUDGET)
  const outputCap = typeof outputLimit === 'number' && Number.isFinite(outputLimit) && outputLimit > 1 ? outputLimit - 1 : Infinity
  const maximum = Math.min(ceiling, outputCap)
  if (!(maximum > 0)) {
    return {}
  }

  const high = Math.min(Math.max(option.min ?? 0, HIGH_BUDGET), maximum)
  const variants: Record<string, Record<string, unknown>> = {}

  const highSettings = adapter.compileBudget?.(high)
  if (highSettings) {
    variants.high = highSettings
  } else {
    warnings.push('budget_tokens unsupported by transport; skipped')
  }

  const maxSettings = adapter.compileBudget?.(maximum)
  if (maxSettings && maximum !== high) {
    variants.max = maxSettings
  }

  return variants
}

function compileToggle(
  adapter: ReasoningTransportAdapter,
  warnings: string[],
): Record<string, Record<string, unknown>> {
  const variants: Record<string, Record<string, unknown>> = {}
  const offSettings = adapter.compileToggle?.(false)
  if (offSettings) {
    variants.none = offSettings
  }
  const onSettings = adapter.compileToggle?.(true)
  if (onSettings) {
    variants.high = onSettings
  }
  if (Object.keys(variants).length === 0) {
    warnings.push('toggle unsupported by transport; skipped')
  }
  return variants
}

export function compileReasoningVariants(input: CompileReasoningVariantsInput): ReasoningCompileResult {
  const warnings: string[] = []
  const adapter = input.adapter ?? getTransportAdapter(input.transport)
  if (!adapter) {
    return { variants: {}, warnings: ['no transport adapter available'] }
  }

  const variants: Record<string, Record<string, unknown>> = {}
  const effort = input.capabilityOptions.find((o) => o.type === 'effort')
  const toggle = input.capabilityOptions.some((o) => o.type === 'toggle')
  const budget = input.capabilityOptions.find((o): o is Extract<ReasoningOption, { type: 'budget_tokens' }> => o.type === 'budget_tokens')

  if (effort && effort.type === 'effort') {
    Object.assign(variants, compileEffort(effort.values, adapter, warnings))
  } else if (toggle && budget) {
    // none + high + max
    Object.assign(variants, compileToggle(adapter, warnings))
    const budgetVariants = compileBudget(budget, adapter, input.outputLimit, warnings)
    if (variants.high && budgetVariants.high) {
      variants.high = { ...variants.high, ...budgetVariants.high }
      delete budgetVariants.high
    }
    Object.assign(variants, budgetVariants)
  } else if (toggle) {
    Object.assign(variants, compileToggle(adapter, warnings))
  } else if (budget) {
    Object.assign(variants, compileBudget(budget, adapter, input.outputLimit, warnings))
  }

  return { variants, warnings }
}
