/**
 * Pure route-to-catalog projection draft (v3 plan §8.1, §8.2, §8.3).
 *
 * The projector never performs I/O and never mutates a host catalog. It
 * separates plugin-owned automatic routes from explicit/host-owned entries,
 * allowing V1 ownership guards and V2 fresh-draft transforms to apply the
 * resulting diff safely later.
 */

import type { DiscoveredRoute, ProjectionState } from './types'

export type ProjectionSemantics = 'strict' | 'observed'
export type ManualModelsPolicy = 'intersect' | 'preserve'

export interface ProjectRoutesInput {
  semantics: ProjectionSemantics
  /** Whether this is a validated complete inventory, including complete-empty. */
  inventoryComplete: boolean
  routes: readonly DiscoveredRoute[]
  /** Explicit/host-owned selection keys that must not be deleted by discovery. */
  explicitSelectionKeys?: readonly string[]
  /** Keys previously injected by this plugin for ownership-aware removal. */
  previousPluginSelectionKeys?: readonly string[]
  /** Optional host/user whitelist; auto routes are intersected with it when set. */
  userWhitelist?: readonly string[]
  /** `preserve` is an explicit non-strict opt-in. */
  manualModels?: ManualModelsPolicy
  /** Host-owned/no-op provider path. */
  noContribution?: boolean
}

export interface ProjectionDraft {
  state: ProjectionState
  /** All keys visible after this projection, deduplicated and sorted. */
  visibleSelectionKeys: string[]
  /** Routes contributed automatically by this plugin in this draft. */
  autoRoutes: DiscoveredRoute[]
  /** Explicit/host-owned keys retained independently of discovery. */
  preservedExplicitSelectionKeys: string[]
  /** Previous plugin-owned keys safe to remove because they disappeared. */
  removedPluginSelectionKeys: string[]
  /** Strictness is false when observed or manualModels=preserve. */
  strict: boolean
  /** Stable reason for audit/debug output. */
  reason: string
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).sort()
}

function routeKey(route: DiscoveredRoute): string {
  return route.selectionKey
}

function deduplicateReadyRoutes(routes: readonly DiscoveredRoute[]): DiscoveredRoute[] {
  const seen = new Set<string>()
  const result: DiscoveredRoute[] = []
  for (const route of routes) {
    // Only ready deployments/endpoints are callable. Unknown/not-ready routes
    // remain diagnostics, never enter a callable projection (§8.4).
    if (route.readiness !== 'ready') continue
    if (route.selectionKey.length === 0 || seen.has(route.selectionKey)) continue
    seen.add(route.selectionKey)
    result.push({ ...route })
  }
  return result.sort((a, b) => a.selectionKey.localeCompare(b.selectionKey))
}

/** Builds a non-mutating projection draft from one inventory observation. */
export function projectRoutes(input: ProjectRoutesInput): ProjectionDraft {
  const explicit = uniqueSorted(input.explicitSelectionKeys ?? [])
  const previous = uniqueSorted(input.previousPluginSelectionKeys ?? [])
  const manualModels = input.manualModels ?? 'intersect'

  if (input.noContribution) {
    return {
      state: 'no-contribution',
      visibleSelectionKeys: explicit,
      autoRoutes: [],
      preservedExplicitSelectionKeys: explicit,
      removedPluginSelectionKeys: [],
      strict: false,
      reason: 'delegated-to-host',
    }
  }

  if (!input.inventoryComplete) {
    const removed = input.semantics === 'strict' ? previous : []
    return {
      state: input.semantics === 'strict' ? 'strict-empty' : 'explicit-only',
      visibleSelectionKeys: explicit,
      autoRoutes: [],
      preservedExplicitSelectionKeys: explicit,
      removedPluginSelectionKeys: removed,
      strict: input.semantics === 'strict',
      reason: 'inventory-unavailable',
    }
  }

  const whitelist = input.userWhitelist === undefined
    ? undefined
    : new Set(uniqueSorted(input.userWhitelist))
  const ready = deduplicateReadyRoutes(input.routes)
  const autoRoutes = whitelist === undefined
    ? ready
    : ready.filter((route) => whitelist.has(routeKey(route)))
  const autoKeys = autoRoutes.map(routeKey)
  const removed = previous.filter((key) => !autoKeys.includes(key))
  const strict = input.semantics === 'strict' && manualModels !== 'preserve'
  const visible = uniqueSorted([...explicit, ...autoKeys])

  let state: ProjectionState
  let reason: string
  if (autoRoutes.length > 0) {
    state = 'fresh'
    reason = strict ? 'complete-inventory' : 'complete-observed-inventory'
  } else if (input.semantics === 'strict') {
    state = 'strict-empty'
    reason = manualModels === 'preserve' ? 'complete-empty-manual-preserve' : 'complete-empty'
  } else {
    state = 'explicit-only'
    reason = 'complete-empty-observed'
  }

  return {
    state,
    visibleSelectionKeys: visible,
    autoRoutes,
    preservedExplicitSelectionKeys: explicit,
    removedPluginSelectionKeys: removed,
    strict,
    reason,
  }
}
