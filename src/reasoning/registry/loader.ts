import type { ReasoningRegistry } from './types'
import { validateRegistry } from './validator'
import { REGISTRY_SCHEMA_VERSION } from './types'

/**
 * Runtime registry loader (design §29).
 *
 * Loads the bundled generated registry JSON at startup. No network is used.
 * If the bundled registry fails validation, it is ignored (fail-open) so a
 * corrupt registry never breaks discovery.
 */

 
let bundled: ReasoningRegistry | undefined

export function getBundledRegistry(): ReasoningRegistry | undefined {
  return bundled
}

/**
 * Loads and validates a registry payload. Returns the validated registry or
 * undefined when invalid. Pure and testable.
 */
export function loadRegistry(data: unknown): ReasoningRegistry | undefined {
  if (!data || typeof data !== 'object') return undefined
  const candidate = data as ReasoningRegistry
  if (!Array.isArray(candidate.models)) return undefined
  if (candidate.schemaVersion !== REGISTRY_SCHEMA_VERSION) return undefined

  const validation = validateRegistry(candidate)
  if (!validation.valid) {
    return undefined
  }
  return candidate
}

/** Test hook to install a registry (also used by the audit). */
export const registryTestUtils = {
  setBundledRegistry(registry: ReasoningRegistry | undefined): void {
    bundled = registry
  },
}