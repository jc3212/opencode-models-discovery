/**
 * Shared adapter vocabulary for provider inventory fetches (WP2).
 *
 * An adapter turns one provider-specific wire protocol into an
 * `InventoryFetchResult`. The result kind feeds the coordinator's completion
 * gate directly; status-code semantics live HERE per §8.4, not in the
 * transport layer.
 *
 * Iron rules encoded by this module:
 * - A 200 with a business-error body (`success=false`, non-empty `code`) or
 *   a schema-violating payload is NEVER complete-empty (§16.2).
 * - Enumeration-only auth failures (401/403/404/405 on a listing endpoint
 *   whose auth does not equal the inference surface) are classified as
 *   `enumeration-unsupported`: explicit items survive, no auth tombstone is
 *   written, and no public/global fallback may follow (§7.1, §8.4).
 * - Only a contract-confirmed failure of the inference identity itself may
 *   set `authTombstoneEligible`.
 */

import type { DiscoveredRoute } from '../types'
import type { CompletionKind } from '../coordinator'
import { DiscoveryHttpError } from '../http-client'

export interface InventoryFetchResult {
  kind: CompletionKind
  routes: DiscoveredRoute[]
  /** Stable machine-readable reason for audit/diagnostic output. */
  reason: string
  /**
   * True only when the adapter's frozen contract proves the CURRENT
   * inference credential itself was rejected on its own serving surface.
   * Never true for enumeration-only endpoints (§8.4).
   */
  authTombstoneEligible: boolean
  /**
   * The endpoint exists but this credential class cannot enumerate through
   * it. Downstream projection becomes EXPLICIT_ONLY: previous automatic
   * contributions are removed, explicit/host-owned items survive untouched.
   */
  enumerationUnsupported: boolean
}

export type InventoryEndpointAuthSemantics =
  /**
   * The endpoint's authentication IS the inference credential check (e.g.
   * generic relay `/v1/models` served by the same gateway that routes
   * inference). A confirmed 401 here rejects the identity itself.
   */
  | 'inference-surface'
  /**
   * The endpoint is an enumeration-specific surface whose auth may differ
   * from the inference path (e.g. OpenRouter `/api/v1/models/user`). Auth
   * failures here only mean "cannot enumerate", nothing about inference.
   */
  | 'enumeration-only'

export interface StatusClassification {
  kind: CompletionKind
  reason: string
  authTombstoneEligible: boolean
  enumerationUnsupported: boolean
}

/**
 * Maps one HTTP status onto the §8.4 result table. `endpointAuth` decides
 * the 401/403 split between a real credential rejection and an unsupported
 * enumeration attempt.
 */
export function classifyInventoryHttpStatus(
  status: number,
  endpointAuth: InventoryEndpointAuthSemantics,
): StatusClassification {
  if (status === 304) return { kind: 'not-modified', reason: 'http-304', authTombstoneEligible: false, enumerationUnsupported: false }
  if (status === 400) return { kind: 'invalid', reason: 'http-400', authTombstoneEligible: false, enumerationUnsupported: false }
  if (status === 401) {
    if (endpointAuth === 'inference-surface') {
      // The serving surface rejected the credential itself: tombstone eligible.
      return { kind: 'auth-failure', reason: 'http-401', authTombstoneEligible: true, enumerationUnsupported: false }
    }
    return { kind: 'auth-failure', reason: 'enumeration-unsupported-http-401', authTombstoneEligible: false, enumerationUnsupported: true }
  }
  if (status === 403) {
    if (endpointAuth === 'inference-surface') {
      // Inventory permission denial on the serving surface: degrade to
      // explicit-only + paused, but NEVER declare the inference key dead
      // from a listing denial alone (§8.4).
      return { kind: 'auth-failure', reason: 'http-403-inventory-denied', authTombstoneEligible: false, enumerationUnsupported: false }
    }
    return { kind: 'auth-failure', reason: 'enumeration-unsupported-http-403', authTombstoneEligible: false, enumerationUnsupported: true }
  }
  if (status === 404 || status === 405) {
    return { kind: 'transient-failure', reason: `enumeration-unsupported-http-${status}`, authTombstoneEligible: false, enumerationUnsupported: true }
  }
  return { kind: 'transient-failure', reason: `http-${status}`, authTombstoneEligible: false, enumerationUnsupported: false }
}

/** Classifies transport-layer failures thrown by the discovery http client. */
export function classifyTransportError(error: unknown): StatusClassification {
  const aborted = error instanceof DiscoveryHttpError && error.code === 'ABORTED'
  return {
    kind: 'transient-failure',
    reason: aborted ? 'transport-aborted' : 'transport-error',
    authTombstoneEligible: false,
    enumerationUnsupported: false,
  }
}

// ---------------------------------------------------------------------------
// Payload validation (§16.2: business bodies are never complete-empty)
// ---------------------------------------------------------------------------

/**
 * Detects gateway business-error envelopes: HTTP 200 but the body declares
 * failure (`success=false`) or carries a non-empty business `code`.
 */
export function detectBusinessErrorBody(json: unknown): { code?: string; message?: string } | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const record = json as Record<string, unknown>
  if (record.success === false) {
    return {
      code: typeof record.code === 'string' && record.code.length > 0 ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
    }
  }
  if (typeof record.error === 'object' && record.error !== null) return { message: JSON.stringify(record.error).slice(0, 200) }
  return undefined
}

export interface RawModelEntryLike {
  id: unknown
  [key: string]: unknown
}

export interface ParsedModelList {
  entries: RawModelEntryLike[]
  /** Entries present but unusable (missing/blank id): force partial, never silent-drop to empty. */
  malformedCount: number
  totalCount?: number
}

/**
 * Accepts the two common list envelopes (`{data:[...]}` and a bare array)
 * and returns validated raw entries. Anything else is a schema violation.
 */
export function parseModelListEnvelope(json: unknown): ParsedModelList | undefined {
  let container: unknown
  let totalCount: number | undefined
  if (Array.isArray(json)) {
    container = json
  } else if (typeof json === 'object' && json !== null) {
    const record = json as Record<string, unknown>
    if (!Array.isArray(record.data)) return undefined
    container = record.data
    if (typeof record.total_count === 'number' && Number.isFinite(record.total_count)) totalCount = record.total_count
  } else {
    return undefined
  }
  let malformedCount = 0
  const entries: RawModelEntryLike[] = []
  for (const candidate of container as unknown[]) {
    if (typeof candidate === 'object' && candidate !== null && typeof (candidate as Record<string, unknown>).id === 'string' && ((candidate as Record<string, unknown>).id as string).length > 0) {
      entries.push(candidate as RawModelEntryLike)
    } else {
      malformedCount += 1
    }
  }
  return { entries, malformedCount, totalCount }
}

/** Maps validated raw entries onto ready model-name routes. */
export function routesFromEntries(entries: readonly RawModelEntryLike[]): DiscoveredRoute[] {
  return entries.map((entry) => ({
    selectionKey: String(entry.id),
    invocationId: String(entry.id),
    routeKind: 'model-name' as const,
    readiness: 'ready' as const,
    maturity: 'stable' as const,
  }))
}
