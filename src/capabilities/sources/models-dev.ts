/**
 * Public-metadata shadow source factory (v3 plan §10.2, §10.3, §10.4; WP5/E7).
 *
 * models.dev-style public catalogs. SHADOW-ONLY by construction: authority
 * capped at `low`, `effort.accepted` (provider-surface control) and
 * `transport.wire` are refused outright, and the API surface is whatever the
 * source declared or must be passed as `'unknown'` — it is never inferred
 * from model names or call shapes. Public shadow candidates can never
 * auto-activate variants; promotion requires provider-native facts, curated
 * registry entries, or an explicit user override.
 */

import type { ReasoningCapabilityEvidence } from '../types'
import { UNKNOWN_SURFACE } from '../indexes'
import { finishEvidence, SourcePolicyError, type BuildEvidenceInput } from './common'

export function publicShadowEvidence(
  draft: Omit<ReasoningCapabilityEvidence, 'source' | 'authority'> & BuildEvidenceInput & {
    /** Source-declared surface or 'unknown'; never guessed here. */
    declaredSurface?: string
  },
): ReasoningCapabilityEvidence {
  const attempted = (draft as { authority?: ReasoningCapabilityEvidence['authority'] }).authority
  if (attempted !== undefined && attempted !== 'low') {
    throw new SourcePolicyError('public-shadow authority is capped at low')
  }
  return finishEvidence('public-shadow', {
    ...draft,
    scope: {
      ...draft.scope,
      apiSurface: draft.declaredSurface ?? draft.scope.apiSurface ?? UNKNOWN_SURFACE,
    },
    authority: 'low',
  })
}
