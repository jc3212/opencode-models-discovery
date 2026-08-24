/**
 * V1 whitelist resolution (v3 plan §5.1, §8.3).
 *
 * Users express allowlists in terms of the model ids they know from provider
 * consoles and previous plugin output. The only safe join back into inventory
 * space is an EXACT equality against `effectiveRemoteApiId` — never prefix,
 * glob, or case-insensitive guessing, because a near-miss would silently
 * authorize a different deployment than the user intended.
 *
 * The resolved selection-key set feeds `ProjectRoutesInput.userWhitelist`.
 * Unmatched entries are reported instead of dropped so hosts can surface
 * configuration mistakes. An absent whitelist means "no restriction"
 * (`undefined` passthrough); an explicitly empty array is restrictive and
 * blocks every auto route.
 */

import type { DiscoveredRoute } from '../types'

export interface WhitelistSourceModel {
  selectionKey: string
  effectiveRemoteApiId: string
}

export interface V1WhitelistResolution {
  /**
   * Selection keys eligible for auto contribution, deduplicated and sorted.
   * `undefined` preserves the "no restriction" contract of the projector.
   */
  selectionKeyWhitelist?: string[]
  /** Whitelist entries that matched no inventory model, sorted, deduplicated. */
  ignoredEntries: string[]
}

/**
 * Resolves a raw user whitelist into selection-key space using exact
 * `effectiveRemoteApiId` equality. Pure function.
 */
export function resolveV1Whitelist(input: {
  models: readonly WhitelistSourceModel[]
  userWhitelist?: readonly string[]
}): V1WhitelistResolution {
  if (input.userWhitelist === undefined) {
    return { ignoredEntries: [] }
  }

  const byEffectiveId = new Map<string, string[]>()
  for (const model of input.models) {
    if (model.selectionKey.length === 0 || model.effectiveRemoteApiId.length === 0) continue
    const keys = byEffectiveId.get(model.effectiveRemoteApiId)
    if (keys) {
      if (!keys.includes(model.selectionKey)) keys.push(model.selectionKey)
    } else {
      byEffectiveId.set(model.effectiveRemoteApiId, [model.selectionKey])
    }
  }

  const matched = new Set<string>()
  const ignored = new Set<string>()
  for (const entry of input.userWhitelist) {
    if (entry.length === 0) continue
    const keys = byEffectiveId.get(entry)
    if (!keys) {
      ignored.add(entry)
      continue
    }
    for (const key of keys) matched.add(key)
  }

  return {
    selectionKeyWhitelist: [...matched].sort(),
    ignoredEntries: [...ignored].sort(),
  }
}

/**
 * Applies the ownership guard to a removal candidate list: a selection key may
 * only be removed when this plugin previously injected it. Host-owned,
 * explicit, and foreign keys always survive, even when stale cache data would
 * otherwise suggest removal (§8.2).
 */
export function applyOwnershipGuard(input: {
  currentSelectionKeys: readonly string[]
  removableCandidates: readonly string[]
  previouslyPluginOwnedKeys?: readonly string[]
}): { kept: string[]; removed: string[] } {
  const current = new Set(input.currentSelectionKeys)
  const owned = new Set(input.previouslyPluginOwnedKeys ?? [])
  const kept: string[] = []
  const removed: string[] = []
  for (const candidate of input.removableCandidates) {
    if (current.has(candidate)) continue
    if (owned.has(candidate)) removed.push(candidate)
    else kept.push(candidate)
  }
  return {
    kept: kept.sort(),
    removed: removed.sort(),
  }
}

/** Re-exported type alias so callers do not import projector internals. */
export type V1RouteKey = DiscoveredRoute['selectionKey']
