/**
 * Curated official-registry source factory (v3 plan §10.2; WP5/E7).
 *
 * Human-reviewed registry entries that EACH carry an official source URL and
 * revision. Ranks below vendor-exact provider-native facts but above public
 * shadow candidates for intrinsic effective strengths.
 */

import type { ReasoningCapabilityEvidence } from '../types'
import { finishEvidence, type BuildEvidenceInput, type CuratedProvenance } from './common'

export function officialRegistryEvidence(
  draft: Omit<ReasoningCapabilityEvidence, 'source' | 'authority'> & {
    authority?: ReasoningCapabilityEvidence['authority']
  } & BuildEvidenceInput &
    CuratedProvenance,
): ReasoningCapabilityEvidence {
  return finishEvidence('official-registry', {
    ...draft,
    authority: draft.authority ?? 'high',
  })
}
