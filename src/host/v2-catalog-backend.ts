/**
 * V2 catalog backend: in-memory snapshot transform (§8.3; E3).
 *
 * The V2 host transform reads ONLY the precompiled in-memory snapshot this
 * module publishes: no network, no disk, no full metadata parsing. Each
 * reload re-applies the snapshot onto a FRESH host draft — mutations never
 * accumulate because the transform is pure over (snapshot, fresh draft).
 *
 * Publication rules mirrored from §8.3:
 * - strict-empty / auth-blocked / disposed snapshots carry an empty plugin
 *   section (published before any network on identity change).
 * - NO_CONTRIBUTION publishes nothing and transforms nothing.
 */

import type { ProjectionDraft } from '../discovery/projector'
import type { ProjectionState } from '../discovery/types'

export interface CatalogSnapshot {
  /** Consumer epoch the snapshot was produced under. */
  epoch: number
  state: ProjectionState
  /** Ready auto routes only; diagnostics never enter a callable catalog. */
  pluginRoutes: ProjectionDraft['autoRoutes']
  generatedAt: string
}

export interface V2CatalogTransformResult {
  /**
   * New object per call. Host-owned content is copied untouched; the plugin
   * section is rebuilt wholesale from the snapshot.
   */
  models: Record<string, unknown>
  appliedRoutes: string[]
  reloadRecommended: boolean
}

const EMPTY_STATES = new Set<ProjectionState>([
  'strict-empty',
  'auth-blocked',
  'explicit-only',
  'unresolved-deny',
  'disposed',
])

function buildEntry(route: ProjectionDraft['autoRoutes'][number]): unknown {
  return {
    discovered: true,
    selectionKey: route.selectionKey,
    invocationId: route.invocationId,
    routeKind: route.routeKind,
    ...(route.canonicalModelId !== undefined
      ? { canonicalModelId: route.canonicalModelId }
      : {}),
  }
}

export class V2CatalogBackend {
  private current?: CatalogSnapshot

  /**
   * Publishes a projection draft as the next catalog snapshot. Returns
   * whether hosts should schedule exactly one `catalog.reload()`.
   */
  publish(draft: ProjectionDraft, epoch: number): { published: boolean; reloadRecommended: boolean } {
    if (draft.state === 'no-contribution') {
      return { published: false, reloadRecommended: false }
    }
    const previous = this.current
    const snapshot: CatalogSnapshot = {
      epoch,
      state: draft.state,
      pluginRoutes: EMPTY_STATES.has(draft.state)
        ? []
        : draft.autoRoutes.map((route) => ({ ...route })),
      generatedAt: new Date().toISOString(),
    }
    this.current = snapshot
    const changed =
      previous === undefined ||
      previous.state !== snapshot.state ||
      JSON.stringify(previous.pluginRoutes) !== JSON.stringify(snapshot.pluginRoutes)
    return { published: true, reloadRecommended: changed }
  }

  /** Read-only view for diagnostics; callers must not mutate. */
  peek(): Readonly<CatalogSnapshot> | undefined {
    return this.current
  }

  /**
   * Re-applies the current snapshot onto a fresh host draft. `hostModels`
   * is treated as fully host-owned and copied verbatim; plugin entries are
   * rebuilt wholesale every call (§8.3 "不累积 mutation").
   */
  transform(hostModels: Record<string, unknown>): V2CatalogTransformResult {
    const snapshot = this.current
    const models: Record<string, unknown> = { ...hostModels }
    if (!snapshot || snapshot.pluginRoutes.length === 0) {
      return { models, appliedRoutes: [], reloadRecommended: false }
    }
    const seen = new Set<string>()
    const appliedRoutes: string[] = []
    for (const route of snapshot.pluginRoutes) {
      if (seen.has(route.selectionKey)) continue
      seen.add(route.selectionKey)
      models[route.selectionKey] = buildEntry(route)
      appliedRoutes.push(route.selectionKey)
    }
    return {
      models,
      appliedRoutes: appliedRoutes.sort(),
      // A transform that changed callable content should be followed by one
      // reload at the call site's discretion; publishing already decided.
      reloadRecommended: false,
    }
  }
}
