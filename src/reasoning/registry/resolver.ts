import type { OfficialReasoningCapability, ReasoningRegistry } from './types'
import { loadRegistry } from './loader'

/**
 * Official registry resolver (design §53, §14-15).
 *
 * Matches a discovered model id to an official registry entry. Priority:
 *   1. user alias (handled by the caller before this)
 *   2. registry exact model id
 *   3. registry alias
 *   4. safe revision alias (only when the entry declares `revision_alias`)
 *
 * No glob/family matching (design §14): `gpt*`, `claude*`, etc. never
 * match a whole family.
 */

export interface OfficialRegistryMatch {
  capability: OfficialReasoningCapability
  source: 'registry-exact' | 'registry-alias' | 'registry-revision'
}

function stripTag(modelId: string): string {
  return modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
}

function buildLookups(registry: ReasoningRegistry): {
  byId: Map<string, OfficialReasoningCapability>
  byAlias: Map<string, OfficialReasoningCapability>
  byLowerId: Map<string, OfficialReasoningCapability>
} {
  const byId = new Map<string, OfficialReasoningCapability>()
  const byAlias = new Map<string, OfficialReasoningCapability>()
  const byLowerId = new Map<string, OfficialReasoningCapability>()

  for (const entry of registry.models) {
    byId.set(entry.model, entry)
    byLowerId.set(entry.model.toLowerCase(), entry)
    for (const alias of entry.aliases ?? []) {
      byAlias.set(alias, entry)
      byAlias.set(alias.toLowerCase(), entry)
    }
  }
  return { byId, byAlias, byLowerId }
}

/**
 * Resolves a model id to its official registry entry, or undefined.
 * `aliases` (user-provided canonical mapping) is checked first by the
 * caller; this function handles registry-level matching.
 */
/**
 * Lookups are built once per registry instance and cached (design §53), so
 * per-model resolution is O(1) map lookup instead of a linear scan.
 */
const lookupCache = new WeakMap<ReasoningRegistry, ReturnType<typeof buildLookups>>()

function getLookups(registry: ReasoningRegistry): ReturnType<typeof buildLookups> {
  let lookups = lookupCache.get(registry)
  if (!lookups) {
    lookups = buildLookups(registry)
    lookupCache.set(registry, lookups)
  }
  return lookups
}

export function resolveOfficialModelCapability(
  modelId: string,
  registry: ReasoningRegistry | undefined,
  options: { aliases?: Record<string, string> } = {},
): OfficialRegistryMatch | undefined {
  if (!registry) return undefined

  const { byId, byAlias, byLowerId } = getLookups(registry)
  const cleanId = stripTag(modelId).trim()

  // 1. User alias (strongest) -> canonical id.
  if (options.aliases && Object.prototype.hasOwnProperty.call(options.aliases, modelId)) {
    const target = options.aliases[modelId]
    if (typeof target === 'string' && target.trim().length > 0) {
      const hit = byId.get(target) ?? byLowerId.get(target.toLowerCase()) ?? byAlias.get(target) ?? byAlias.get(target.toLowerCase())
      if (hit) return { capability: hit, source: 'registry-exact' }
    }
  }

  // 2. Registry exact model id.
  const exact = byId.get(cleanId) ?? byLowerId.get(cleanId.toLowerCase())
  if (exact) return { capability: exact, source: 'registry-exact' }

  // 3. Registry alias.
  const alias = byAlias.get(cleanId) ?? byAlias.get(cleanId.toLowerCase())
  if (alias) return { capability: alias, source: 'registry-alias' }

  // 4. Safe revision alias (only when declared).
  const revisionMatch = cleanId.match(/-(?:\d{4}-\d{2}-\d{2}|v\d+)$/)
  if (revisionMatch) {
    const baseId = cleanId.slice(0, -revisionMatch[0].length)
    const base = byId.get(baseId) ?? byLowerId.get(baseId.toLowerCase()) ??
      byAlias.get(baseId) ?? byAlias.get(baseId.toLowerCase())
    if (base && base.revision_alias === true) {
      return { capability: base, source: 'registry-revision' }
    }
  }

  return undefined
}
