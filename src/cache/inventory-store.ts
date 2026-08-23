/**
 * Complete-inventory store for cache v3 (v3 plan §9.1 item 1, §9.2).
 *
 * One file per exact semantic inventory identity, keyed by its HMAC hash.
 * Only `completeness: 'complete'` records live here — partial responses go
 * to quarantine and must never overwrite a complete LKG (§8.4). Route
 * objects are allowlist-sanitized before anything touches disk, so extra
 * fields from adapters cannot smuggle themselves into the persisted state.
 */

import {
  computeSemanticIdentityHash,
  type HmacSecret,
} from '../discovery/identity'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from '../discovery/types'
import {
  CacheFileError,
  assertFullHashName,
  readJsonOptional,
  removeCacheFile,
  writeJsonAtomic,
} from './safe-file'

const INVENTORY_DIR = 'inventories/v3'

const ROUTE_KINDS = new Set([
  'model-name',
  'deployment-id',
  'endpoint-id',
  'inference-profile',
  'resource-arn',
] as const)
const READINESS = new Set(['ready', 'not-ready', 'unknown'] as const)
const MATURITY = new Set(['stable', 'experimental'] as const)

export interface StoredInventoryRecordV3 {
  schemaVersion: 3
  identityHash: string
  identity: SemanticInventoryIdentityV3
  activatedFromCredentialGenerationHash: string
  completeness: 'complete'
  receivedAt: string
  validatedAt: string
  activatedAt: string
  etag?: string
  sourceRevision?: string
  routes: DiscoveredRoute[]
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`route field "${field}" must be a non-empty string`)
  }
  return value
}

/**
 * Rebuilds each route from allowlisted fields only. Unknown properties are
 * dropped; missing required fields or out-of-domain enums fail the whole
 * save so a malformed adapter payload can never reach disk as "complete".
 */
export function sanitizeRoutes(routes: readonly DiscoveredRoute[]): DiscoveredRoute[] {
  return routes.map((route, index) => {
    if (route === null || typeof route !== 'object') {
      throw new TypeError(`routes[${index}] must be an object`)
    }
    const kind = requireNonEmptyString(route.routeKind, 'routeKind')
    if (!ROUTE_KINDS.has(kind as DiscoveredRoute['routeKind'])) {
      throw new TypeError(`routes[${index}].routeKind "${kind}" is not a known route kind`)
    }
    const readiness = requireNonEmptyString(route.readiness, 'readiness')
    if (!READINESS.has(readiness as DiscoveredRoute['readiness'])) {
      throw new TypeError(`routes[${index}].readiness "${readiness}" is not a known readiness`)
    }
    const maturity = requireNonEmptyString(route.maturity ?? 'experimental', 'maturity')
    if (!MATURITY.has(maturity as DiscoveredRoute['maturity'])) {
      throw new TypeError(`routes[${index}].maturity "${maturity}" is not a known maturity`)
    }
    const sanitized: DiscoveredRoute = {
      selectionKey: requireNonEmptyString(route.selectionKey, 'selectionKey'),
      invocationId: requireNonEmptyString(route.invocationId, 'invocationId'),
      routeKind: kind as DiscoveredRoute['routeKind'],
      readiness: readiness as DiscoveredRoute['readiness'],
      maturity: maturity as DiscoveredRoute['maturity'],
    }
    if (route.canonicalModelId !== undefined) {
      sanitized.canonicalModelId = requireNonEmptyString(route.canonicalModelId, 'canonicalModelId')
    }
    if (route.deploymentId !== undefined) {
      sanitized.deploymentId = requireNonEmptyString(route.deploymentId, 'deploymentId')
    }
    return sanitized
  })
}

function inventoryPath(cacheRoot: string, identityHash: string): string {
  assertFullHashName(identityHash)
  return `${cacheRoot}/${INVENTORY_DIR}/${identityHash}.json`
}

export interface SaveCompleteInventoryOptions {
  /** Plugin data root, e.g. `<xdgData>/@jc3212/opencode-models-discovery`. */
  cacheRoot: string
  secret: HmacSecret
  identity: SemanticInventoryIdentityV3
  /** Hash of the credential generation that produced this inventory. */
  activatedFromCredentialGenerationHash: string
  routes: readonly DiscoveredRoute[]
  receivedAt?: string
  validatedAt?: string
  etag?: string
  sourceRevision?: string
}

export interface SavedInventoryLocation {
  identityHash: string
  path: string
}

/** Persists one complete inventory atomically under its identity hash. */
export async function saveCompleteInventory(
  options: SaveCompleteInventoryOptions,
): Promise<SavedInventoryLocation> {
  if (typeof options.activatedFromCredentialGenerationHash !== 'string' ||
      options.activatedFromCredentialGenerationHash.length === 0) {
    throw new TypeError('activatedFromCredentialGenerationHash is required')
  }
  const sanitizedRoutes = sanitizeRoutes(options.routes)
  const now = new Date().toISOString()
  const identityHash = computeSemanticIdentityHash(options.secret, options.identity)
  const record: StoredInventoryRecordV3 = {
    schemaVersion: 3,
    identityHash,
    identity: options.identity,
    activatedFromCredentialGenerationHash: options.activatedFromCredentialGenerationHash,
    completeness: 'complete',
    receivedAt: options.receivedAt ?? now,
    validatedAt: options.validatedAt ?? now,
    activatedAt: now,
    ...(options.etag !== undefined ? { etag: options.etag } : {}),
    ...(options.sourceRevision !== undefined ? { sourceRevision: options.sourceRevision } : {}),
    routes: sanitizedRoutes,
  }
  const finalPath = await writeJsonAtomic(
    options.cacheRoot,
    INVENTORY_DIR,
    `${identityHash}.json`,
    record,
  )
  return { identityHash, path: finalPath }
}

export interface LoadInventoryOptions {
  cacheRoot: string
  secret: HmacSecret
  identity: SemanticInventoryIdentityV3
}

function isPlausibleStoredRecord(value: unknown): value is StoredInventoryRecordV3 {
  if (value === null || typeof value !== 'object') return false
  const record = value as StoredInventoryRecordV3
  return (
    record.schemaVersion === 3 &&
    record.completeness === 'complete' &&
    typeof record.identityHash === 'string' &&
    typeof record.activatedFromCredentialGenerationHash === 'string' &&
    record.identity !== null && typeof record.identity === 'object' &&
    Array.isArray(record.routes) &&
    record.routes.every((r) =>
      r !== null && typeof r === 'object' &&
      typeof (r as DiscoveredRoute).selectionKey === 'string' &&
      typeof (r as DiscoveredRoute).invocationId === 'string')
  )
}

/**
 * Loads the complete LKG for the EXACT identity. Returns undefined when the
 * file is missing, unreadable-as-v3, tampered (stored identity hashes to a
 * different key), or structurally implausible — callers then behave as if
 * no LKG exists, which is the safe direction.
 */
export async function loadCompleteInventory(
  options: LoadInventoryOptions,
): Promise<StoredInventoryRecordV3 | undefined> {
  const identityHash = computeSemanticIdentityHash(options.secret, options.identity)
  const result = await readJsonOptional<StoredInventoryRecordV3>(
    inventoryPath(options.cacheRoot, identityHash),
  )
  if (!result.ok) return undefined
  const record = result.value
  if (!isPlausibleStoredRecord(record)) return undefined
  // Tamper / key-drift check: the stored identity must hash back to the
  // filename key. Anything else is treated as absent.
  const recomputed = computeSemanticIdentityHash(options.secret, record.identity)
  if (recomputed !== identityHash || record.identityHash !== identityHash) {
    return undefined
  }
  return record
}

/** Deletes the complete LKG for the exact identity. Returns existence. */
export async function deleteCompleteInventory(
  options: LoadInventoryOptions,
): Promise<boolean> {
  const identityHash = computeSemanticIdentityHash(options.secret, options.identity)
  try {
    return await removeCacheFile(inventoryPath(options.cacheRoot, identityHash))
  } catch (error) {
    throw new CacheFileError(
      'IO_ERROR',
      `failed to delete inventory: ${String((error as Error)?.message ?? error)}`,
    )
  }
}
