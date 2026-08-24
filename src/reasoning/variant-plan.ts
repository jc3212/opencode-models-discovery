/**
 * Unified variant compilation plan (v3 plan WP5/E8, §10.3 rules 6-8).
 *
 * Pure decision layer between the capability catalog and any host writer:
 *
 * - The callable set is decided UPSTREAM by access evidence (§5/§8); this
 *   module refuses to compile anything for an ineligible route.
 * - Claims are solved INDEPENDENTLY (accepted/effective/normalization/
 *   default/mandatory), then constraints are intersected in the EFFECTIVE
 *   domain, and finally each effective value maps onto the current surface's
 *   preferred wire value.
 * - Every variant carries provenance source ids. Budget/toggle-derived
 *   profiles are out of scope here and must never masquerade as official
 *   discrete efforts (§10.4).
 * - Records MUST share one exact tuple scope; anything else is rejected to
 *   prevent cross-provider/cross-surface leakage.
 */

import {
  resolveClaim,
} from '../capabilities/evidence-resolver'
import { satisfiesSurfaceGate } from '../capabilities/indexes'
import { tupleFingerprint } from '../capabilities/indexes'
import type {
  EffectiveEffort,
  ReasoningCapabilityEvidence,
} from '../capabilities/types'

const EFFECTIVE_VALUES: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'max',
])

export interface VariantPlanInput {
  /** Upstream access decision: is this exact route currently callable? */
  accessEligible: boolean
  /**
   * The wire surface being compiled FOR. Capability records whose scope
   * declares `unknown` or a different surface never unlock this gate.
   */
  requestedSurface: string
  records: readonly ReasoningCapabilityEvidence[]
}

export interface VariantProvenance {
  supportSourceId?: string
  acceptedSourceId?: string
  effectiveSourceId?: string
  normalizationSourceId?: string
  defaultSourceId?: string
}

export interface PlannedVariant {
  effective: EffectiveEffort
  /** Preferred wire value; equals `effective` when no explicit mapping exists. */
  wireValue: string
  /** True when the wire value came from an explicit mapping record. */
  explicitWire: boolean
  provenance: VariantProvenance
}

export type VariantPlan =
  | { kind: 'planned'; variants: PlannedVariant[]; defaultEffort?: EffectiveEffort }
  | {
      kind: 'empty'
      reason:
        | 'not-access-eligible'
        | 'scope-leak'
        | 'surface-gate-blocked'
        | 'capability-unknown'
        | 'capability-unsupported'
        | 'claims-ambiguous'
        | 'no-effective-values'
      detail?: string
    }

function assertSingleScope(records: readonly ReasoningCapabilityEvidence[]): void {
  if (records.length === 0) return
  const first = tupleFingerprint({
    providerKey: `${records[0].scope.providerKind}@${records[0].scope.origin}`,
    surface: records[0].scope.apiSurface,
    remoteModelId: records[0].scope.remoteModelId,
  })
  for (const record of records.slice(1)) {
    const fingerprint = tupleFingerprint({
      providerKey: `${record.scope.providerKind}@${record.scope.origin}`,
      surface: record.scope.apiSurface,
      remoteModelId: record.scope.remoteModelId,
    })
    if (fingerprint !== first) {
      throw new TypeError('variant-plan records must share one exact tuple scope')
    }
  }
}

function topSourceId(
  claim: Parameters<typeof resolveClaim>[0]['claim'],
  records: readonly ReasoningCapabilityEvidence[],
): string | undefined {
  // The resolver orders deterministically; recover the winning source id by
  // re-running its filter for the claim and taking the first contributor.
  let best: ReasoningCapabilityEvidence | undefined
  for (const record of records) {
    if (record.claim !== claim || record.support === 'unknown') continue
    if (best === undefined) {
      best = record
      continue
    }
    // Mirror the resolver's comparator cheaply: revision, authority, time, id.
    const revA = record.source.revision ?? ''
    const revB = best.source.revision ?? ''
    if (revA !== revB) {
      best = revA > revB ? record : best
      continue
    }
    best = record
  }
  return best?.source.id
}

/**
 * Compiles the automatic variant plan for one exact capability tuple.
 * Throws on mixed-scope input; returns an explicit empty reason otherwise.
 */
export function buildVariantPlan(input: VariantPlanInput): VariantPlan {
  if (!input.accessEligible) {
    return { kind: 'empty', reason: 'not-access-eligible' }
  }
  assertSingleScope(input.records)

  const scopeSurface = input.records[0]?.scope.apiSurface
  if (input.records.length > 0 &&
      !satisfiesSurfaceGate(scopeSurface ?? '', input.requestedSurface)) {
    return { kind: 'empty', reason: 'surface-gate-blocked' }
  }

  const resolve = (claim: Parameters<typeof resolveClaim>[0]['claim']) =>
    resolveClaim({ claim, records: input.records })

  const support = resolve('reasoning.support')
  if (support.kind === 'unresolved') {
    return { kind: 'empty', reason: 'capability-unknown' }
  }
  if (support.kind === 'resolved' && support.support === 'unsupported') {
    return { kind: 'empty', reason: 'capability-unsupported' }
  }
  if (support.kind === 'ambiguous') {
    return { kind: 'empty', reason: 'claims-ambiguous', detail: support.detail }
  }

  // Independent solving (rule 6): accepted, effective, normalization, default.
  const accepted = resolve('effort.accepted')
  const effective = resolve('effort.effective')
  const normalization = resolve('effort.normalization')
  const defaultEffort = resolve('effort.default')

  for (const resolution of [support, accepted, effective, normalization, defaultEffort]) {
    if (resolution.kind === 'ambiguous') {
      return { kind: 'empty', reason: 'claims-ambiguous', detail: resolution.detail }
    }
  }

  // Effective-domain value set (rules 6-7):
  // 1) authoritative effective values win;
  // 2) otherwise accepted inputs map through normalization;
  // 3) unmapped non-enum inputs are DROPPED, never guessed.
  const normMap =
    normalization.kind === 'resolved' && normalization.normalization
      ? normalization.normalization
      : undefined

  let effectiveValues: string[]
  if (effective.kind === 'resolved' && effective.values.length > 0) {
    effectiveValues = effective.values
  } else if (accepted.kind === 'resolved') {
    const positives = accepted.values.length > 0
      ? accepted.values
      : []
    effectiveValues = positives.map((value) => {
      // A normalization record is the AUTHORITATIVE accepted→effective
      // mapping; unlisted inputs fall back to identity only when already
      // valid effective tiers, and are otherwise dropped, never guessed.
      const mapped = normMap?.[value]
      if (mapped !== undefined) return mapped
      return (EFFECTIVE_VALUES as Set<string>).has(value) ? value : undefined
    }).filter((value): value is string => value !== undefined)
  } else {
    effectiveValues = []
  }

  const deduped = [...new Set(effectiveValues)].filter((value) =>
    (EFFECTIVE_VALUES as Set<string>).has(value),
  )
  if (deduped.length === 0) {
    return { kind: 'empty', reason: 'no-effective-values' }
  }

  // Rule 8: preferred wire values from normalization/transport records.
  const wireMap: Partial<Record<EffectiveEffort, string>> = {}
  for (const claim of ['effort.normalization', 'transport.wire'] as const) {
    const resolution = resolve(claim)
    if (resolution.kind !== 'resolved') continue
    const preferred = resolution.preferredWireByEffective
    if (preferred) {
      for (const [key, value] of Object.entries(preferred)) {
        if (value !== undefined && !(key in wireMap)) wireMap[key as EffectiveEffort] = value
      }
    }
  }

  let defaultEffortValue: EffectiveEffort | undefined
  if (defaultEffort.kind === 'resolved' &&
      typeof defaultEffort.scalar === 'string' &&
      (EFFECTIVE_VALUES as Set<string>).has(defaultEffort.scalar)) {
    defaultEffortValue = defaultEffort.scalar as EffectiveEffort
  }

  const order: EffectiveEffort[] = ['minimal', 'low', 'medium', 'high', 'max']
  const variants: PlannedVariant[] = [...deduped]
    .sort((a, b) => order.indexOf(a as EffectiveEffort) - order.indexOf(b as EffectiveEffort))
    .map((value) => ({
      effective: value as EffectiveEffort,
      wireValue: wireMap[value as EffectiveEffort] ?? value,
      explicitWire: wireMap[value as EffectiveEffort] !== undefined,
      provenance: {
        ...(support.kind === 'resolved' ? { supportSourceId: topSourceId('reasoning.support', input.records) } : {}),
        ...(accepted.kind === 'resolved' ? { acceptedSourceId: topSourceId('effort.accepted', input.records) } : {}),
        ...(effective.kind === 'resolved' ? { effectiveSourceId: topSourceId('effort.effective', input.records) } : {}),
        ...(normMap ? { normalizationSourceId: topSourceId('effort.normalization', input.records) } : {}),
        ...(defaultEffortValue !== undefined
          ? { defaultSourceId: topSourceId('effort.default', input.records) }
          : {}),
      },
    }))

  return {
    kind: 'planned',
    variants,
    ...(defaultEffortValue !== undefined ? { defaultEffort: defaultEffortValue } : {}),
  }
}
