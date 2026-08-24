/**
 * V1 config backend: ownership-protected models injection (§8.2; E3).
 *
 * V1 hosts mutate a live config object. The only safe write protocol:
 *
 * - Remember, per (config, provider), the USER'S original entries and the
 *   plugin's LAST-INJECTED entries.
 * - On shrink, remove a key ONLY when its current value is strictly equal
 *   to what this plugin last injected — anything else was modified by the
 *   user or another plugin and must survive untouched.
 * - When the provider leaves managed mode (`no-op`), restore only entries
 *   still strictly equal to the plugin's own injections.
 *
 * This module never imports v2 entrypoints (V1/V2 isolation, plan WP8).
 */

import type { ProjectionDraft } from '../discovery/projector'

export interface V1OwnershipRecord {
  /** Entries present before the plugin ever touched this provider. */
  readonly originalValues: ReadonlyMap<string, unknown>
  /** What the plugin injected last round (strict-equality removal target). */
  lastInjected: Map<string, string>
  /** Consumer epoch at last apply; a change revokes prior injections. */
  epoch: number
}

export interface V1ApplyReport {
  injected: string[]
  removed: string[]
  /** Keys that vanished from the projection but survived (user/foreign edits). */
  preservedForeign: string[]
}

function canonical(value: unknown): string {
  return JSON.stringify(value)
}

export class V1ConfigBackend {
  private readonly records = new WeakMap<object, Map<string, V1OwnershipRecord>>()

  private recordFor(config: object, providerId: string): V1OwnershipRecord | undefined {
    return this.records.get(config)?.get(providerId)
  }

  /**
   * Applies one projection draft to `models` for a provider. `epoch` must
   * come from the consumer's coordinator snapshot; an epoch change discards
   * previous ownership claims without touching user content.
   *
   * `models` is mutated in place exactly like the legacy config hook does;
   * everything else is read-only. Pure with respect to inputs other than
   * the documented mutation target.
   */
  applyProjection(input: {
    config: object
    providerId: string
    epoch: number
    draft: ProjectionDraft
    models: Record<string, unknown>
    /** Serialize route selection keys into model entries. */
    buildModelEntry?: (selectionKey: string) => unknown
  }): V1ApplyReport {
    const { config, providerId, draft } = input

    let providers = this.records.get(config)
    if (!providers) {
      providers = new Map()
      this.records.set(config, providers)
    }
    let record = providers.get(providerId)
    if (!record) {
      record = {
        originalValues: new Map(Object.entries(input.models)),
        lastInjected: new Map(),
        epoch: input.epoch,
      }
      providers.set(providerId, record)
    }
    if (record.epoch !== input.epoch) {
      // Identity/plan change: previous injections lose protection claims.
      record.epoch = input.epoch
      record.lastInjected = new Map()
    }

    const report: V1ApplyReport = { injected: [], removed: [], preservedForeign: [] }
    const desiredKeys = new Set(draft.autoRoutes.map((route) => route.selectionKey))

    // Removal pass (ownership-guarded).
    for (const key of [...record.lastInjected.keys()]) {
      if (desiredKeys.has(key)) continue
      const current = input.models[key]
      if (current === undefined) {
        record.lastInjected.delete(key)
        continue
      }
      if (canonical(current) === record.lastInjected.get(key)) {
        delete input.models[key]
        record.lastInjected.delete(key)
        report.removed.push(key)
      } else {
        report.preservedForeign.push(key)
      }
    }

    // Injection pass.
    for (const route of draft.autoRoutes) {
      const key = route.selectionKey
      const entry = input.buildModelEntry
        ? input.buildModelEntry(key)
        : { discovered: true, selectionKey: key }
      const serialized = canonical(entry)
      if (canonical(record.lastInjected.get(key) ?? null) !== serialized) {
        input.models[key] = entry
        report.injected.push(key)
      }
      record.lastInjected.set(key, serialized)
    }

    return report
  }

  /**
   * Managed→no-op exit: restore only entries still strictly equal to what
   * this plugin injected. User-edited or foreign entries are never touched.
   */
  releaseOwnedEntries(input: {
    config: object
    providerId: string
    models: Record<string, unknown>
  }): string[] {
    const record = this.recordFor(input.config, input.providerId)
    if (!record) return []
    const restored: string[] = []
    for (const [key, serialized] of [...record.lastInjected.entries()]) {
      if (canonical(input.models[key]) === serialized) {
        delete input.models[key]
        record.lastInjected.delete(key)
        restored.push(key)
      }
    }
    return restored.sort()
  }
}
