/**
 * V2 catalog fresh-draft transform (v3 plan §8.2, §8.3).
 *
 * V2 replaces the legacy merge-into-stale-cache behavior: when a validated
 * complete inventory exists, the plugin-owned catalog section is rebuilt from
 * scratch (a "fresh draft") and never merged with previously cached plugin
 * content. Host-owned and explicit entries are untouched; removals are bounded
 * by the ownership guard — only keys this plugin previously injected may be
 * removed. Without a complete inventory the transform refuses to act and the
 * previous draft is retained (refresh state machines decide staleness).
 */

import type { DiscoveredRoute } from '../types'

export interface V2CatalogFreshDraft {
  /** The new authoritative plugin-owned section, deduplicated and sorted. */
  pluginOwnedRoutes: DiscoveredRoute[]
  /** Explicit/host-owned keys preserved independently of this transform. */
  preservedExplicitSelectionKeys: string[]
  /** Previous plugin-owned keys absent from the fresh inventory. */
  removedPluginSelectionKeys: string[]
}

export type V2CatalogTransform =
  | { kind: 'fresh'; draft: V2CatalogFreshDraft }
  | { kind: 'retain-previous'; reason: string }

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).sort()
}

function readyDeduplicated(routes: readonly DiscoveredRoute[]): DiscoveredRoute[] {
  const seen = new Set<string>()
  const result: DiscoveredRoute[] = []
  for (const route of routes) {
    if (route.readiness !== 'ready') continue
    if (route.selectionKey.length === 0 || seen.has(route.selectionKey)) continue
    seen.add(route.selectionKey)
    result.push({ ...route })
  }
  return result.sort((a, b) => a.selectionKey.localeCompare(b.selectionKey))
}

/**
 * Builds a V2 catalog transform from one projection input set. Pure function:
 * identical inputs produce identical drafts, no I/O.
 *
 * Only `readiness === 'ready'` routes enter the fresh section; unknown or
 * not-ready routes stay diagnostics-only (§8.4).
 */
export function buildV2CatalogTransform(input: {
  inventoryComplete: boolean
  autoRoutes: readonly DiscoveredRoute[]
  explicitSelectionKeys?: readonly string[]
  previouslyPluginOwnedKeys?: readonly string[]
}): V2CatalogTransform {
  const explicit = uniqueSorted(input.explicitSelectionKeys ?? [])
  const previous = uniqueSorted(input.previouslyPluginOwnedKeys ?? [])

  if (!input.inventoryComplete) {
    return { kind: 'retain-previous', reason: 'inventory-unavailable' }
  }

  const fresh = readyDeduplicated(input.autoRoutes)
  const currentKeys = new Set(fresh.map((route) => route.selectionKey))
  const explicitKeys = new Set(explicit)
  // Ownership guard: removal candidates are pre-filtered to previously
  // plugin-owned keys before diffing against the fresh section; explicitly
  // preserved host keys survive even when stale plugin data claims them.
  const removed = previous.filter((key) => !currentKeys.has(key) && !explicitKeys.has(key))

  return {
    kind: 'fresh',
    draft: {
      pluginOwnedRoutes: fresh,
      preservedExplicitSelectionKeys: explicit,
      removedPluginSelectionKeys: removed,
    },
  }
}
