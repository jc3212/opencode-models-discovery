/**
 * Refresh-completion persistence flow (v3 plan §8.4, §9.1; WP1/WP4 glue).
 *
 * Single decision point mapping a coordinator `CompletionKind` onto the
 * cache v3 stores. Rules mirror the frozen contracts exactly:
 *
 * - `complete` (including authoritative complete-empty) overwrites the
 *   per-identity complete LKG.
 * - `partial` and `invalid` go to quarantine ONLY; a partial response can
 *   never overwrite a complete LKG (§8.4).
 * - `not-modified` and `transient-failure` persist nothing (backoff is the
 *   scheduler's business).
 * - `auth-failure` writes a tombstone bound to the exact
 *   (identity × credential generation) pair ONLY when the adapter contract
 *   confirmed the inference credential itself was rejected; enumeration-only
 *   or permission denials persist nothing (§7.1, §8.4).
 *
 * Identity hashes are always recomputed here from `(secret, identity)` —
 * caller-supplied hashes are never trusted on the write path.
 */

import type { CompletionKind } from './coordinator'
import { computeSemanticIdentityHash, type HmacSecret } from './identity'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from './types'
import {
  loadCompleteInventory,
  saveCompleteInventory,
  type StoredInventoryRecordV3,
} from '../cache/inventory-store'
import { appendQuarantineEntry, type QuarantineKind } from '../cache/quarantine-store'
import {
  hasAuthTombstone,
  writeAuthTombstone,
  type StoredAuthTombstoneV1,
} from '../cache/tombstone-store'

export interface PersistenceDecision {
  action: 'save-inventory' | 'write-tombstone' | 'quarantine' | 'no-op'
  /** Stable machine-readable reason for audit output. */
  reason: string
}

/** Pure completion → store-action matrix. No I/O, deterministic. */
export function decidePersistence(input: {
  kind: CompletionKind
  confirmedIdentityAuthFailure?: boolean
}): PersistenceDecision {
  switch (input.kind) {
    case 'complete':
      return { action: 'save-inventory', reason: 'complete-lkg' }
    case 'partial':
      return { action: 'quarantine', reason: 'partial-never-overwrites-lkg' }
    case 'invalid':
      return { action: 'quarantine', reason: 'invalid-schema' }
    case 'not-modified':
      return { action: 'no-op', reason: 'not-modified' }
    case 'transient-failure':
      return { action: 'no-op', reason: 'transient-backoff-only' }
    case 'auth-failure':
      return input.confirmedIdentityAuthFailure === false
        ? { action: 'no-op', reason: 'unconfirmed-auth-no-tombstone' }
        : { action: 'write-tombstone', reason: 'confirmed-auth-failure' }
  }
}

function requireGenerationHash(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('credentialGenerationHash is required for this persistence action')
  }
  return value
}

export type AppliedRefreshPersistence =
  | { action: 'save-inventory'; identityHash: string; path: string; routeCount: number }
  | { action: 'write-tombstone'; identityHash: string; path: string }
  | { action: 'quarantine'; identityHash: string; path: string; pruned: number }
  | { action: 'no-op'; reason: string }

export interface ApplyRefreshCompletionOptions {
  cacheRoot: string
  secret: HmacSecret
  identity: SemanticInventoryIdentityV3
  /**
   * Hash of the credential generation that produced this completion.
   * Required for `complete` and confirmed `auth-failure`; ignored otherwise.
   */
  credentialGenerationHash?: string
  kind: CompletionKind
  routes?: readonly DiscoveredRoute[]
  confirmedIdentityAuthFailure?: boolean
  receivedAt?: string
  etag?: string
  sourceRevision?: string
  /** Adapter-provided short lowercase reason code for quarantine entries. */
  quarantineReason?: string
  summary?: Record<string, string | number | boolean>
}

const QUARANTINE_KIND_BY_COMPLETION: Partial<Record<CompletionKind, QuarantineKind>> = {
  partial: 'partial-response',
  invalid: 'schema-invalid',
}

/**
 * Persists one refresh completion according to the decision matrix.
 * Store failures propagate: callers decide whether a failed tombstone write
 * aborts the refresh cycle (fail-closed) or degrades to in-memory handling.
 */
export async function applyRefreshCompletion(
  options: ApplyRefreshCompletionOptions,
): Promise<AppliedRefreshPersistence> {
  const decision = decidePersistence({
    kind: options.kind,
    confirmedIdentityAuthFailure: options.confirmedIdentityAuthFailure,
  })
  if (decision.action === 'no-op') {
    return { action: 'no-op', reason: decision.reason }
  }

  const identityHash = computeSemanticIdentityHash(options.secret, options.identity)

  if (decision.action === 'save-inventory') {
    const generationHash = requireGenerationHash(options.credentialGenerationHash)
    const saved = await saveCompleteInventory({
      cacheRoot: options.cacheRoot,
      secret: options.secret,
      identity: options.identity,
      activatedFromCredentialGenerationHash: generationHash,
      routes: options.routes ?? [],
      ...(options.receivedAt !== undefined ? { receivedAt: options.receivedAt } : {}),
      ...(options.etag !== undefined ? { etag: options.etag } : {}),
      ...(options.sourceRevision !== undefined ? { sourceRevision: options.sourceRevision } : {}),
    })
    return {
      action: 'save-inventory',
      identityHash: saved.identityHash,
      path: saved.path,
      routeCount: (options.routes ?? []).length,
    }
  }

  if (decision.action === 'write-tombstone') {
    const generationHash = requireGenerationHash(options.credentialGenerationHash)
    const path = await writeAuthTombstone({
      cacheRoot: options.cacheRoot,
      secret: options.secret,
      identityHash,
      credentialGenerationHash: generationHash,
      reason: decision.reason,
      ...(options.receivedAt !== undefined ? { createdAt: options.receivedAt } : {}),
    })
    return { action: 'write-tombstone', identityHash, path }
  }

  const quarantineKind = QUARANTINE_KIND_BY_COMPLETION[options.kind]
  if (quarantineKind === undefined) {
    // Unreachable while decidePersistence and this map stay in sync.
    return { action: 'no-op', reason: 'unmapped-quarantine-kind' }
  }
  const appended = await appendQuarantineEntry({
    cacheRoot: options.cacheRoot,
    secret: options.secret,
    kind: quarantineKind,
    reason: options.quarantineReason ?? quarantineKind,
    identityHash,
    ...(options.receivedAt !== undefined ? { observedAt: options.receivedAt } : {}),
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
  })
  return {
    action: 'quarantine',
    identityHash,
    path: appended.path,
    pruned: appended.pruned,
  }
}

export interface StartupCacheState {
  /** Complete same-identity LKG, when one survives integrity checks. */
  lkg?: StoredInventoryRecordV3
  /** Tombstone for the exact (identity × credential generation) pair. */
  tombstone?: StoredAuthTombstoneV1
}

/**
 * Read-side snapshot of what cache v3 holds for one exact identity and
 * credential generation. Reports facts only; precedence (tombstone beats
 * LKG activation) belongs to the projection/refresh state machines.
 */
export async function loadStartupCacheState(options: {
  cacheRoot: string
  secret: HmacSecret
  identity: SemanticInventoryIdentityV3
  credentialGenerationHash: string
}): Promise<StartupCacheState> {
  const identityHash = computeSemanticIdentityHash(options.secret, options.identity)
  const [lkg, tombstone] = await Promise.all([
    loadCompleteInventory({
      cacheRoot: options.cacheRoot,
      secret: options.secret,
      identity: options.identity,
    }),
    hasAuthTombstone(
      options.cacheRoot,
      options.secret,
      identityHash,
      options.credentialGenerationHash,
    ),
  ])
  return {
    ...(lkg !== undefined ? { lkg } : {}),
    ...(tombstone !== undefined ? { tombstone } : {}),
  }
}
