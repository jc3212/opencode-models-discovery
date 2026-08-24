/**
 * Capability tuple indexes (v3 plan §10.4; WP5).
 *
 * The ONLY sanctioned join into capability space is the exact tuple
 * `(catalogProviderKey, sourceDeclaredSurface, exactRemoteModelId)`:
 *
 * - No basename folding, namespace stripping, or date-suffix trimming ever
 *   produces an index key. Such near-misses may exist as DIAGNOSTIC
 *   candidates elsewhere but never unlock capabilities here.
 * - Inserting a duplicate under an already-present exact key is a FAILURE,
 *   never a silent overwrite: two sources claiming the same exact binding
 *   must be reconciled upstream, not last-write-wins.
 * - `surface === 'unknown'` (source declared none) is stored verbatim and
 *   NEVER guessed from call shape; unknown-surface entries can satisfy at
 *   most intrinsic/canonical lookups and never unlock provider-surface
 *   control or transport gates.
 */

import type { EvidenceScope } from './types'

export const UNKNOWN_SURFACE = 'unknown'

/** Stable provider dimension of the tuple, derived from frozen scope fields. */
export function catalogProviderKey(
  scope: Pick<EvidenceScope, 'providerKind' | 'origin'>,
): string {
  if (scope.providerKind.length === 0 || scope.origin.length === 0) {
    throw new TypeError('catalogProviderKey requires non-empty providerKind and origin')
  }
  return `${scope.providerKind}@${scope.origin}`
}

export interface CapabilityTupleKey {
  providerKey: string
  /** Source-declared API surface; `unknown` when the source declared none. */
  surface: string
  /** Exact wire model id as the provider returned it. */
  remoteModelId: string
}

export function tupleFingerprint(key: CapabilityTupleKey): string {
  return `${key.providerKey}\u0000${key.surface}\u0000${key.remoteModelId}`
}

export class DuplicateCapabilityEntryError extends TypeError {
  constructor(fingerprint: string) {
    super(`duplicate capability entry for exact tuple "${fingerprint.replaceAll('\u0000', '|')}"`)
    this.name = 'DuplicateCapabilityEntryError'
  }
}

/**
 * Exact-first tuple index. One bucket per full tuple; inserting an existing
 * fingerprint again throws instead of overwriting (§10.4 重复=失败).
 */
export class CapabilityIndex<T> {
  private readonly buckets = new Map<string, T[]>()

  insert(key: CapabilityTupleKey, value: T): void {
    if (key.providerKey.length === 0 || key.remoteModelId.length === 0 || key.surface.length === 0) {
      throw new TypeError('capability tuple requires non-empty providerKey/surface/remoteModelId')
    }
    const fingerprint = tupleFingerprint(key)
    const existing = this.buckets.get(fingerprint)
    if (existing !== undefined) {
      throw new DuplicateCapabilityEntryError(fingerprint)
    }
    this.buckets.set(fingerprint, [value])
  }

  /** Exact triple match only; no fallbacks of any kind. */
  lookupExact(key: CapabilityTupleKey): readonly T[] | undefined {
    return this.buckets.get(tupleFingerprint(key))
  }

  /**
   * All entries for `(providerKey, remoteModelId)` regardless of surface.
   * Diagnostic/canonical-candidate use ONLY: results carry their stored
   * surface and still pass through gate checks before unlocking anything.
   */
  lookupByModel(providerKey: string, remoteModelId: string): Array<{ surface: string; value: T }> {
    const results: Array<{ surface: string; value: T }> = []
    for (const [fingerprint, values] of this.buckets) {
      const parts = fingerprint.split('\u0000')
      if (parts[0] !== providerKey || parts[2] !== remoteModelId) continue
      for (const value of values) results.push({ surface: parts[1] ?? '', value })
    }
    return results.sort((a, b) => a.surface.localeCompare(b.surface))
  }

  size(): number {
    return this.buckets.size
  }
}

/**
 * Whether an entry whose stored surface is `stored` may satisfy a
 * provider-surface CONTROL or TRANSPORT gate for `requested`. Unknown
 * surfaces never unlock; mismatched surfaces never unlock.
 */
export function satisfiesSurfaceGate(stored: string, requested?: string): boolean {
  if (stored.length === 0 || stored === UNKNOWN_SURFACE) return false
  if (requested === undefined) return true
  return stored === requested
}
