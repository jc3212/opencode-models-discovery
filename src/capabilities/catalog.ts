/**
 * Capability catalog (v3 plan §10.1, §10.4; WP5).
 *
 * The catalog binds validated reasoning-capability evidence to exact route
 * tuples `(providerKey, declaredSurface, remoteModelId)`. Ingestion is
 * fail-closed: every record must pass `validateReasoningCapabilityEvidence`
 * BEFORE it is indexed, and re-asserting the SAME atomic claim on the same
 * exact tuple is a reported failure rather than an overwrite.
 *
 * Multiple DIFFERENT claims about the same tuple are expected (a model can
 * have `reasoning.support` AND `effort.accepted`). Entries stored under
 * `surface === 'unknown'` never satisfy provider-surface control/transport
 * gates (§10.4).
 */

import {
  validateReasoningCapabilityEvidence,
  type ReasoningAtomicClaim,
  type ReasoningCapabilityEvidence,
} from './types'
import {
  catalogProviderKey,
  satisfiesSurfaceGate,
  UNKNOWN_SURFACE,
  type CapabilityTupleKey,
} from './indexes'

export type CatalogAddResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-evidence'; detail: string }
  | { ok: false; reason: 'duplicate-claim'; detail: string }

function tupleOf(evidence: ReasoningCapabilityEvidence): CapabilityTupleKey {
  return {
    providerKey: catalogProviderKey(evidence.scope),
    surface: evidence.scope.apiSurface,
    remoteModelId: evidence.scope.remoteModelId,
  }
}

function tupleFingerprint(key: CapabilityTupleKey): string {
  return `${key.providerKey}\u0000${key.surface}\u0000${key.remoteModelId}`
}

export interface ExactLookupInput {
  providerKind: string
  origin: string
  apiSurface: string
  remoteModelId: string
}

type ClaimBucket = ReadonlyMap<ReasoningAtomicClaim, ReasoningCapabilityEvidence>

export class CapabilityCatalog {
  private readonly tuples = new Map<string, Map<ReasoningAtomicClaim, ReasoningCapabilityEvidence>>()

  /** Validates then indexes one evidence record. */
  add(evidence: ReasoningCapabilityEvidence): CatalogAddResult {
    const validation = validateReasoningCapabilityEvidence(evidence)
    if (!validation.ok) {
      return { ok: false, reason: 'invalid-evidence', detail: validation.reason }
    }

    const fingerprint = tupleFingerprint(tupleOf(evidence))
    let bucket = this.tuples.get(fingerprint)
    if (bucket === undefined) {
      bucket = new Map([[evidence.claim, evidence]])
      this.tuples.set(fingerprint, bucket)
      return { ok: true }
    }
    if (bucket.has(evidence.claim)) {
      return {
        ok: false,
        reason: 'duplicate-claim',
        detail: `${evidence.claim} already bound for this exact tuple`,
      }
    }
    bucket.set(evidence.claim, evidence)
    return { ok: true }
  }

  /**
   * Exact-tuple claim lookup. Without `requested`, returns the stored bucket
   * regardless of declared surface (canonical/intrinsic candidate use). With
   * `requested`, this becomes a control/transport gate: entries stored under
   * `unknown` or a mismatched surface never satisfy it (§10.4).
   */
  lookupExact(
    input: ExactLookupInput & { requested?: string },
  ): ClaimBucket | undefined {
    if (input.requested !== undefined &&
        !satisfiesSurfaceGate(input.apiSurface, input.requested)) {
      return undefined
    }
    return this.tuples.get(
      tupleFingerprint({
        providerKey: catalogProviderKey({ providerKind: input.providerKind, origin: input.origin }),
        surface: input.apiSurface,
        remoteModelId: input.remoteModelId,
      }),
    )
  }

  /**
   * Cross-surface diagnostic candidates for `(providerKind, origin, remoteModelId)`.
   * These are NOT capability grants; every consumer must re-run gate checks
   * (`satisfiesSurfaceGate`) before unlocking anything.
   */
  lookupCandidates(
    input: Omit<ExactLookupInput, 'apiSurface'>,
  ): Array<{ surface: string; claims: ClaimBucket }> {
    const providerKey = catalogProviderKey({ providerKind: input.providerKind, origin: input.origin })
    const results: Array<{ surface: string; claims: ClaimBucket }> = []
    for (const [fingerprint, bucket] of this.tuples) {
      const parts = fingerprint.split('\u0000')
      if (parts[0] !== providerKey || parts[2] !== input.remoteModelId) continue
      results.push({ surface: parts[1] ?? UNKNOWN_SURFACE, claims: bucket })
    }
    return results.sort((a, b) => a.surface.localeCompare(b.surface))
  }

  size(): number {
    return this.tuples.size
  }
}

export { satisfiesSurfaceGate, UNKNOWN_SURFACE }
