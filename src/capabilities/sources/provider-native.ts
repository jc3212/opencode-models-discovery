/**
 * Provider-native source factory (v3 plan §10.2; WP5/E7).
 *
 * The current provider's own API responses, documentation, or SDK behavior
 * observed for the EXACT model+surface. Highest authority; the only source
 * class that can satisfy provider-surface control claims on its own.
 */

import type { ReasoningCapabilityEvidence } from '../types'
import { finishEvidence, type BuildEvidenceInput } from './common'

export function providerNativeEvidence(
  draft: Omit<ReasoningCapabilityEvidence, 'source' | 'authority'> & {
    authority?: ReasoningCapabilityEvidence['authority']
  } & BuildEvidenceInput,
): ReasoningCapabilityEvidence {
  return finishEvidence('provider-native', {
    ...draft,
    ...(draft.authority !== undefined ? { authority: draft.authority } : { authority: 'exact' as const }),
  })
}
