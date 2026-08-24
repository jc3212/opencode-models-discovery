/**
 * Legacy v2 cache migration (v3 plan §9.5, WP4).
 *
 * The old provider-model-store cache contains a broad model catalog keyed only
 * by provider/baseURL/endpoint. That identity is insufficient for a strict
 * v3 inventory. Migration therefore extracts ONLY user overrides and never
 * promotes legacy discovered models into inventories or projections.
 *
 * This module accepts a legacy state-shaped value rather than importing the
 * legacy store class, keeping migration deterministic and easy to audit. The
 * caller supplies the provider id and a v3 override writer; no legacy file is
 * deleted and malformed legacy data is skipped fail-closed.
 */

export type LegacyOverride = Record<string, unknown>

export interface LegacyProviderStateLike {
  version?: unknown
  provider?: { id?: unknown; baseURL?: unknown; endpoint?: unknown }
  models?: unknown
  overrides?: unknown
  reasoningFingerprint?: unknown
}

export interface V3OverrideRecord {
  schemaVersion: 1
  providerId: string
  modelId: string
  override: LegacyOverride
  migratedFrom: 'provider-model-store-v2'
}

export interface V2MigrationResult {
  status: 'migrated-overrides' | 'no-overrides' | 'skipped-invalid'
  migrated: V3OverrideRecord[]
  skippedModelIds: string[]
  discoveredModelsNotMigrated: number
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeOverride(value: unknown): LegacyOverride | undefined {
  if (!plainObject(value)) return undefined
  const result: LegacyOverride = {}
  for (const [key, child] of Object.entries(value)) {
    // id is owned by the new route/inventory identity and must not be
    // migrated as a user override. Credential-shaped fields are discarded.
    if (key === 'id' || /^(api[-_]?key|authorization|token|password|secret|credentials?)$/i.test(key)) continue
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean' || child === null) {
      result[key] = child
    } else if (plainObject(child)) {
      const nested = sanitizeOverride(child)
      if (nested && Object.keys(nested).length > 0) result[key] = nested
    }
  }
  return result
}

/**
 * Extracts safe overrides from one legacy state. Discovered models are
 * counted for an audit report but deliberately not migrated as v3 inventory.
 */
export function migrateLegacyProviderState(
  providerId: string,
  state: LegacyProviderStateLike,
): V2MigrationResult {
  if (!providerId || state.version !== 2 || !plainObject(state.overrides)) {
    return {
      status: 'skipped-invalid',
      migrated: [],
      skippedModelIds: [],
      discoveredModelsNotMigrated: plainObject(state.models) ? Object.keys(state.models).length : 0,
    }
  }

  const migrated: V3OverrideRecord[] = []
  const skippedModelIds: string[] = []
  for (const [modelId, rawOverride] of Object.entries(state.overrides)) {
    const override = sanitizeOverride(rawOverride)
    if (!override || Object.keys(override).length === 0) {
      skippedModelIds.push(modelId)
      continue
    }
    migrated.push({
      schemaVersion: 1,
      providerId,
      modelId,
      override,
      migratedFrom: 'provider-model-store-v2',
    })
  }

  return {
    status: migrated.length > 0 ? 'migrated-overrides' : 'no-overrides',
    migrated,
    skippedModelIds,
    discoveredModelsNotMigrated: plainObject(state.models) ? Object.keys(state.models).length : 0,
  }
}
