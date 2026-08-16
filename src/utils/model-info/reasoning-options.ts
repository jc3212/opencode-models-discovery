import type { ReasoningOption } from '../../reasoning/types'

/**
 * Normalizes a raw models.dev `reasoning_options` value into a typed list
 * of ReasoningOption. This is intentionally conservative:
 *
 * - Unknown option shapes are dropped, never guessed.
 * - `effort` requires a non-empty string array.
 * - `budget_tokens` keeps only finite positive min/max numbers.
 * - `toggle` has no payload.
 *
 * The field is optional in current models.dev data, so an absent or malformed
 * value simply yields an empty list (never an error).
 */
export function normalizeReasoningOptions(raw: unknown): ReasoningOption[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const options: ReasoningOption[] = []

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue
    }
    const item = entry as Record<string, unknown>

    switch (item.type) {
      case 'effort': {
        // Conservatively require every value to be a non-empty string.
        // A single malformed entry drops the entire option rather than
        // guessing which values are trustworthy.
        const values = Array.isArray(item.values)
          ? item.values.every((v): v is string => typeof v === 'string' && v.length > 0)
            ? item.values
            : []
          : []
        if (values.length > 0) {
          options.push({ type: 'effort', values })
        }
        break
      }
      case 'toggle': {
        options.push({ type: 'toggle' })
        break
      }
      case 'budget_tokens': {
        const min = isFinitePositive(item.min) ? item.min : undefined
        const max = isFinitePositive(item.max) ? item.max : undefined
        if (min !== undefined || max !== undefined) {
          options.push({ type: 'budget_tokens', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) })
        }
        break
      }
      default:
        break
    }
  }

  return options
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
