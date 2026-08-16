import type {
  OfficialReasoningCapability,
  ReasoningBudgetControl,
  ReasoningEffortControl,
  ReasoningRegistry,
} from './types'
import { REGISTRY_SCHEMA_VERSION } from './types'

/**
 * Registry validator (design §33).
 *
 * Enforces structural invariants so a bad registry can never ship or be
 * loaded at runtime:
 *   - canonical model ids are unique
 *   - aliases are unique and do not collide with canonical ids
 *   - effort values are non-empty and de-duplicated
 *   - effort default exists in values
 *   - effort alias targets exist in values
 *   - budget min <= max
 *   - evidence exists
 *   - updatedAt / verifiedAt are valid dates
 */

export interface RegistryValidationResult {
  valid: boolean
  errors: string[]
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function validateRegistry(registry: ReasoningRegistry): RegistryValidationResult {
  const errors: string[] = []

  if (registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REGISTRY_SCHEMA_VERSION}, got ${registry.schemaVersion}`)
  }
  if (!registry.registryVersion || typeof registry.registryVersion !== 'string') {
    errors.push('registryVersion must be a non-empty string')
  }

  const seenIds = new Set<string>()
  const seenAliases = new Set<string>()

  for (const entry of registry.models) {
    validateEntry(entry, seenIds, seenAliases, errors)
  }

  return { valid: errors.length === 0, errors }
}

function validateEntry(
  entry: OfficialReasoningCapability,
  seenIds: Set<string>,
  seenAliases: Set<string>,
  errors: string[],
): void {
  const where = `model ${entry.model}:`

  if (seenIds.has(entry.model)) {
    errors.push(`${where} duplicate canonical id`)
  }
  seenIds.add(entry.model)

  if (!DATE_RE.test(entry.updatedAt)) {
    errors.push(`${where} updatedAt must be YYYY-MM-DD`)
  }
  if (!entry.reasoning && entry.controls.length > 0) {
    errors.push(`${where} reasoning=false but controls are present`)
  }
  if (entry.reasoning && entry.controls.length === 0) {
    errors.push(`${where} reasoning=true but no controls`)
  }
  if (entry.sources.length === 0) {
    errors.push(`${where} must have at least one evidence source`)
  }
  for (const source of entry.sources) {
    if (!DATE_RE.test(source.verifiedAt)) {
      errors.push(`${where} source verifiedAt must be YYYY-MM-DD`)
    }
  }

  for (const alias of entry.aliases ?? []) {
    if (seenAliases.has(alias) || seenIds.has(alias)) {
      errors.push(`${where} alias ${alias} is not unique`)
    }
    seenAliases.add(alias)
  }

  for (const control of entry.controls) {
    if (control.type === 'effort') {
      validateEffortControl(control, where, errors)
    } else if (control.type === 'budget_tokens') {
      validateBudgetControl(control, where, errors)
    }
  }
}

function validateEffortControl(control: ReasoningEffortControl, where: string, errors: string[]): void {
  if (!Array.isArray(control.values) || control.values.length === 0) {
    errors.push(`${where} effort values must be a non-empty array`)
    return
  }
  const seen = new Set<string>()
  for (const value of control.values) {
    if (seen.has(value)) {
      errors.push(`${where} duplicate effort value ${value}`)
    }
    seen.add(value)
  }

  if (control.default !== undefined && !control.values.includes(control.default)) {
    errors.push(`${where} effort default ${control.default} not in values`)
  }

  for (const [alias, target] of Object.entries(control.aliases ?? {})) {
    if (!control.values.includes(target)) {
      errors.push(`${where} effort alias ${alias} -> ${target} target not in values`)
    }
  }
}

function validateBudgetControl(control: ReasoningBudgetControl, where: string, errors: string[]): void {
  if (control.min !== undefined && control.max !== undefined && control.min > control.max) {
    errors.push(`${where} budget min > max`)
  }
}
