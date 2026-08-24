/**
 * Manual user-override source factory (v3 plan §10.2; WP5/E7).
 *
 * User capability overrides are configuration INTENT. Diagnostics must show
 * the `manual:` provenance — an override never masquerades as an official
 * fact, and identity aliases never gift capabilities (alias ≠ override;
 * they are separate configuration planes).
 */

import type { ReasoningCapabilityEvidence } from '../types'
import { finishEvidence, type BuildEvidenceInput } from './common'

export function manualOverrideEvidence(
  draft: Omit<ReasoningCapabilityEvidence, 'source' | 'authority'> & BuildEvidenceInput,
): ReasoningCapabilityEvidence {
  return finishEvidence('manual', {
    ...draft,
    authority: 'medium',
  })
}
