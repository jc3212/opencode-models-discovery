/**
 * Shared source-class vocabulary for capability evidence factories
 * (v3 plan §10.2, §10.3; WP5/E7).
 *
 * Every factory produces VALIDATED `ReasoningCapabilityEvidence` only —
 * none of them write variants or touch host catalogs (enrichers produce
 * normalized facts, nothing else). Provenance rides on `source.id`
 * prefixes so diagnostics can always tell fact classes apart:
 *
 * - `provider-native:`  current provider's own exact API/docs/SDK facts.
 * - `official-registry:` curated registry entries WITH per-entry official
 *    source URL + revision (required).
 * - `public-shadow:`    models.dev-style public metadata. SHADOW-ONLY:
 *    capped at `low` authority, never `transport.wire` or provider-surface
 *    control claims (`effort.accepted`), surface stays what the source
 *    declared or `unknown` — never guessed.
 * - `manual:`           user capability override. Configuration intent,
 *    always labeled manual, never dressed up as official fact.
 */

import {
  validateReasoningCapabilityEvidence,
  type ReasoningAtomicClaim,
  type ReasoningCapabilityEvidence,
} from '../types'

export type SourceClass =
  | 'provider-native'
  | 'official-registry'
  | 'public-shadow'
  | 'manual'

export const SOURCE_ID_PREFIX: Record<SourceClass, string> = Object.freeze({
  'provider-native': 'provider-native:',
  'official-registry': 'official-registry:',
  'public-shadow': 'public-shadow:',
  manual: 'manual:',
})

/** Claims public metadata sources may NEVER emit (§10.2, §10.3). */
const FORBIDDEN_FOR_PUBLIC: ReadonlySet<ReasoningAtomicClaim> = new Set([
  'effort.accepted',
  'transport.wire',
])

export interface BuildEvidenceInput {
  sourceId: string
  receivedAt: string
  activatedAt: string
}

/** Optional per-entry official provenance for curated sources. */
export interface CuratedProvenance {
  url: string
  revision: string
}

export class SourcePolicyError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'SourcePolicyError'
  }
}

/**
 * Stamps provenance onto a draft record, enforces the source-class policy,
 * validates fail-closed, and returns the finished evidence. Throws on any
 * policy violation instead of silently degrading it.
 */
export function finishEvidence(
  sourceClass: SourceClass,
  draft: Omit<ReasoningCapabilityEvidence, 'source'> &
    BuildEvidenceInput &
    Partial<CuratedProvenance>,
): ReasoningCapabilityEvidence {
  if (sourceClass === 'public-shadow') {
    if (FORBIDDEN_FOR_PUBLIC.has(draft.claim)) {
      throw new SourcePolicyError(`public-shadow sources may not emit ${draft.claim}`)
    }
    if (draft.authority !== undefined && draft.authority !== 'low') {
      throw new SourcePolicyError('public-shadow authority is capped at low')
    }
    if (draft.scope.apiSurface === undefined || draft.scope.apiSurface.length === 0) {
      throw new SourcePolicyError('apiSurface must be declared explicitly or "unknown"')
    }
  }
  if (sourceClass === 'official-registry') {
    if (!draft.url || draft.url.length === 0 || !draft.revision || draft.revision.length === 0) {
      throw new SourcePolicyError(
        'official-registry entries require per-entry official url and revision',
      )
    }
  }

  const evidence: ReasoningCapabilityEvidence = {
    ...draft,
    authority: draft.authority as ReasoningCapabilityEvidence['authority'],
    scope: draft.scope,
    claim: draft.claim,
    support: draft.support,
    completeness: draft.completeness,
    source: {
      ...(draft.url !== undefined ? { url: draft.url } : {}),
      ...(draft.revision !== undefined ? { revision: draft.revision } : {}),
      id: `${SOURCE_ID_PREFIX[sourceClass]}${draft.sourceId}`,
      receivedAt: draft.receivedAt,
      activatedAt: draft.activatedAt,
    },
  } as ReasoningCapabilityEvidence

  const validation = validateReasoningCapabilityEvidence(evidence)
  if (!validation.ok) {
    throw new SourcePolicyError(`invalid ${sourceClass} evidence: ${validation.reason}`)
  }
  return evidence
}
