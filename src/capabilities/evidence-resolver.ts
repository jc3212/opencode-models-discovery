/**
 * Completeness-aware evidence merge for ONE atomic claim (v3 plan §10.3; WP5/E6).
 *
 * Input: records sharing the SAME atomic claim and EXACTLY identical scope.
 * The resolver applies the frozen rules:
 *
 * 1. Deterministic order: latest `source.revision`, then claim-specific
 *    authority rank (exact > high > medium > low), then newest `receivedAt`,
 *    then stable `source.id`.
 * 2. `unknown` records never contribute (fall through).
 * 3. `partial` accumulates positive values and applies explicit negatives;
 *    MISSING values are never negative.
 * 4. The first `exhaustive` record fixes the authoritative set and STOPS
 *    expansion into strictly-lower ranks; an equally-ranked record with a
 *    DIFFERENT payload is a conflict.
 * 5. Same-rank conflicts resolve to `ambiguous`: the model stays, automatic
 *    variants must be suppressed by the caller.
 * 9. An empty values array means "authoritative empty" only from an
 *    `exhaustive` record; from `partial` it contributes nothing.
 */

import type {
  ReasoningAtomicClaim,
  ReasoningCapabilityEvidence,
  SupportState,
} from './types'

const AUTHORITY_RANK: Record<ReasoningCapabilityEvidence['authority'], number> = {
  exact: 4,
  high: 3,
  medium: 2,
  low: 1,
}

function compareRecords(
  a: ReasoningCapabilityEvidence,
  b: ReasoningCapabilityEvidence,
): number {
  const revA = a.source.revision ?? ''
  const revB = b.source.revision ?? ''
  if (revA !== revB) return revA < revB ? 1 : -1
  const rankDiff =
    AUTHORITY_RANK[b.authority] - AUTHORITY_RANK[a.authority]
  if (rankDiff !== 0) return rankDiff
  if (a.source.receivedAt !== b.source.receivedAt) {
    return a.source.receivedAt < b.source.receivedAt ? 1 : -1
  }
  return a.source.id.localeCompare(b.source.id)
}

/** Value-bearing claims whose payloads are `values` / `negativeValues`. */
const VALUE_CLAIMS: ReadonlySet<string> = new Set([
  'effort.accepted',
  'effort.effective',
  'toggle',
])

export type ClaimResolution =
  | { kind: 'unresolved'; reason: 'no-records' | 'all-unknown' }
  | {
      kind: 'resolved'
      support: SupportState
      /** Positive accumulated values after negative subtraction. */
      values: string[]
      negativeValues: string[]
      scalar?: string | boolean | number
      budgetRange?: ReasoningCapabilityEvidence['budgetRange']
      normalization?: ReasoningCapabilityEvidence['normalization']
      preferredWireByEffective?: ReasoningCapabilityEvidence['preferredWireByEffective']
      completeness: 'partial' | 'exhaustive'
      ambiguous: false
    }
  | {
      kind: 'ambiguous'
      support: SupportState
      detail: string
    }

function sameValueSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}

/**
 * Merges records for exactly one atomic claim. Pure function; records are
 * consumed in the frozen priority order and never mutated.
 */
export function resolveClaim(input: {
  claim: ReasoningAtomicClaim
  records: readonly ReasoningCapabilityEvidence[]
}): ClaimResolution {
  const relevant = input.records.filter((record) => record.claim === input.claim)
  if (relevant.length === 0) return { kind: 'unresolved', reason: 'no-records' }

  const ordered = [...relevant].sort(compareRecords)
  const contributing = ordered.filter((record) => record.support !== 'unknown')
  if (contributing.length === 0) return { kind: 'unresolved', reason: 'all-unknown' }

  const top = contributing[0]

  // Scalar-shaped claims: highest-ranked record wins; equal-rank disagreement is ambiguity.
  if (!VALUE_CLAIMS.has(top.claim)) {
    let scalar = top.scalar
    if (top.completeness === 'partial' && top.values && top.values.length === 0) {
      scalar = undefined
    }
    for (const record of contributing.slice(1)) {
      if (record.authority !== top.authority) break
      if (record.scalar !== undefined && top.scalar !== undefined &&
          record.scalar !== top.scalar) {
        return {
          kind: 'ambiguous',
          support: top.support,
          detail: `${input.claim}: same-rank scalars differ (${String(top.scalar)} vs ${String(record.scalar)})`,
        }
      }
    }
    const payloadRecord = contributing.find(
      (record) =>
        record.normalization !== undefined ||
        record.budgetRange !== undefined ||
        record.preferredWireByEffective !== undefined,
    )
    return {
      kind: 'resolved',
      support: top.support,
      values: [],
      negativeValues: [],
      ...(scalar !== undefined ? { scalar } : {}),
      ...(payloadRecord?.normalization !== undefined
        ? { normalization: payloadRecord.normalization }
        : {}),
      ...(payloadRecord?.budgetRange !== undefined
        ? { budgetRange: payloadRecord.budgetRange }
        : {}),
      ...(payloadRecord?.preferredWireByEffective !== undefined
        ? { preferredWireByEffective: payloadRecord.preferredWireByEffective }
        : {}),
      completeness: top.completeness === 'exhaustive' ? 'exhaustive' : 'partial',
      ambiguous: false,
    }
  }

  // Value-bearing claims: ordered accumulation with negatives and exhaustion.
  const positives: string[] = []
  const negatives: string[] = []
  let completeness: 'partial' | 'exhaustive' = 'partial'

  for (let index = 0; index < contributing.length; index += 1) {
    const record = contributing[index]
    const recordPositives = record.values ?? []
    const recordNegatives = record.negativeValues ?? []

    if (record.completeness === 'exhaustive') {
      // Authoritative set; empty array IS meaningful here (rule 9).
      const fixed = [...recordPositives].filter((v) => !recordNegatives.includes(v))
      // Same-rank disagreement → ambiguity.
      for (const peer of contributing.slice(index + 1)) {
        if (peer.authority !== record.authority) break
        const peerValues = (peer.values ?? []).filter((v) => !(peer.negativeValues ?? []).includes(v))
        if (!sameValueSet(fixed, peerValues)) {
          return {
            kind: 'ambiguous',
            support: record.support,
            detail: `${input.claim}: same-rank exhaustive records disagree`,
          }
        }
      }
      positives.length = 0
      positives.push(...fixed)
      negatives.push(...recordNegatives)
      completeness = 'exhaustive'
      break
    }

    for (const value of recordPositives) {
      if (!positives.includes(value)) positives.push(value)
    }
    for (const value of recordNegatives) {
      if (!negatives.includes(value)) negatives.push(value)
    }
  }

  const values = positives.filter((value) => !negatives.includes(value)).sort()
  return {
    kind: 'resolved',
    support: top.support,
    values,
    negativeValues: [...new Set(negatives)].sort(),
    completeness,
    ambiguous: false,
  }
}
