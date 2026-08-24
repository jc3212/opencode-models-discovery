/**
 * Capability evidence ledger (v3 plan §5.1; WP5 groundwork).
 *
 * Built strictly on the WP0-frozen `AccessEvidence` contract. Two rules
 * govern everything here:
 *
 * 1. Evidence RECORDS observations; it never UPGRADES them. An inventory
 *    listing proves at most `credential-visible` for the observed semantic
 *    identity — it cannot mint `account-authorized`, `deployment-ready` or
 *    `policy-eligible` claims, and it can never upgrade official Registry
 *    facts (the same boundary as Relay forwarding evidence).
 * 2. Evidence is scoped by `inventoryIdentityHash`. Records never leak
 *    across identities and credential material never appears here; identity
 *    enters only as the HMAC fingerprint computed upstream.
 */

import type { AccessEvidence } from '../types'

/** Refresh outcomes an inventory observation can carry into the ledger. */
export type ObservationOutcome =
  | 'complete-nonempty'
  | 'complete-empty'
  | 'not-modified'
  | 'partial'
  | 'invalid'
  | 'transient-failure'
  | 'auth-failure'

export interface DeriveEvidenceInput {
  /** Hash of the SemanticInventoryIdentityV3 this observation belongs to. */
  inventoryIdentityHash: string
  outcome: ObservationOutcome
  /**
   * Ready selection keys observed in THIS response body. Must never contain
   * keys merged in from cache or previous observations.
   */
  observedRouteKeys?: readonly string[]
  source: { adapterId: string; endpoint: string; revision?: string }
  receivedAt: string
}

/** Upper bound on derived records per single observation. */
export const MAX_EVIDENCE_PER_OBSERVATION = 512

function makeRecord(
  input: DeriveEvidenceInput,
  routeKey: string,
  state: AccessEvidence['state'],
  completeness: AccessEvidence['completeness'],
): AccessEvidence {
  return {
    inventoryIdentityHash: input.inventoryIdentityHash,
    routeKey,
    claim: 'credential-visible',
    state,
    completeness,
    source: {
      adapterId: input.source.adapterId,
      endpoint: input.source.endpoint,
      ...(input.source.revision === undefined ? {} : { revision: input.source.revision }),
      receivedAt: input.receivedAt,
    },
  }
}

/**
 * Derives evidence records from ONE inventory observation. Pure function:
 * identical inputs produce identical output; no I/O, no clock reads.
 *
 * Only listings that actually returned routes mint records:
 * - `complete-nonempty` → exhaustive `allowed` per observed ready key.
 * - `partial` → `partial` completeness per observed ready key.
 * Everything else (`complete-empty`, `not-modified`, `invalid`,
 * `transient-failure`, `auth-failure`) yields no records: there are no
 * observed routes to attach per-route claims to, and inventing denials or
 * revocations from absence would exceed what the wire proved.
 */
export function deriveEvidenceFromObservation(input: DeriveEvidenceInput): AccessEvidence[] {
  if (input.inventoryIdentityHash.length === 0) return []
  if (input.outcome !== 'complete-nonempty' && input.outcome !== 'partial') return []

  const seen = new Set<string>()
  const keys: string[] = []
  for (const key of input.observedRouteKeys ?? []) {
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  keys.sort()

  const state: AccessEvidence['state'] = 'allowed'
  const completeness: AccessEvidence['completeness'] =
    input.outcome === 'complete-nonempty' ? 'exhaustive' : 'partial'

  const records: AccessEvidence[] = []
  for (const key of keys) {
    if (records.length >= MAX_EVIDENCE_PER_OBSERVATION) break
    records.push(makeRecord(input, key, state, completeness))
  }
  return records
}

export interface EvidenceLedgerOptions {
  /** Maximum retained records per identity hash. Default 512. */
  maxEntriesPerIdentity?: number
}

const DEFAULT_MAX_ENTRIES_PER_IDENTITY = 512

function recordFingerprint(record: AccessEvidence): string {
  return [
    record.inventoryIdentityHash,
    record.routeKey,
    record.claim,
    record.state,
    record.completeness,
    record.source.revision ?? '',
    record.source.receivedAt,
  ].join('\u0000')
}

/**
 * In-memory, bounded, identity-scoped evidence store. Insertion-ordered per
 * identity; when the bound is exceeded the OLDEST records are evicted first
 * (deterministic FIFO, not random). Duplicate records — identical across all
 * frozen fields — are ignored instead of growing the ledger.
 */
export class EvidenceLedger {
  private readonly entries = new Map<string, AccessEvidence[]>()
  private readonly maxEntries: number

  constructor(options?: EvidenceLedgerOptions) {
    const requested = options?.maxEntriesPerIdentity ?? DEFAULT_MAX_ENTRIES_PER_IDENTITY
    this.maxEntries = Number.isInteger(requested) && requested > 0
      ? requested
      : DEFAULT_MAX_ENTRIES_PER_IDENTITY
  }

  record(records: AccessEvidence | readonly AccessEvidence[]): void {
    const list = Array.isArray(records) ? records : [records]
    for (const record of list) {
      if (!record || typeof record !== 'object') continue
      if (record.inventoryIdentityHash.length === 0) continue
      let bucket = this.entries.get(record.inventoryIdentityHash)
      if (!bucket) {
        bucket = []
        this.entries.set(record.inventoryIdentityHash, bucket)
      }
      const fingerprint = recordFingerprint(record)
      const duplicate = bucket.some((existing) => recordFingerprint(existing) === fingerprint)
      if (duplicate) continue
      bucket.push({
        ...record,
        source: { ...record.source },
      })
      while (bucket.length > this.maxEntries) bucket.shift()
    }
  }

  query(filter: {
    inventoryIdentityHash: string
    routeKey?: string
  }): AccessEvidence[] {
    const bucket = this.entries.get(filter.inventoryIdentityHash)
    if (!bucket) return []
    const matched = filter.routeKey === undefined
      ? bucket
      : bucket.filter((record) => record.routeKey === filter.routeKey)
    // Stable output independent of insertion order quirks.
    return matched
      .map((record) => ({ ...record, source: { ...record.source } }))
      .sort((a, b) =>
        a.source.receivedAt.localeCompare(b.source.receivedAt) ||
        a.routeKey.localeCompare(b.routeKey),
      )
  }

  /** Number of retained records; pass a hash to scope to one identity. */
  size(inventoryIdentityHash?: string): number {
    if (inventoryIdentityHash === undefined) {
      let total = 0
      for (const bucket of this.entries.values()) total += bucket.length
      return total
    }
    return this.entries.get(inventoryIdentityHash)?.length ?? 0
  }

  clear(): void {
    this.entries.clear()
  }
}
