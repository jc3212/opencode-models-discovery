/**
 * Identity keys and fingerprint primitives (v3 plan §3.3, §9.2; WP0/WP4).
 *
 * Pure layer: every function here takes the installation secret as an
 * explicit argument and performs no I/O, no env reads, no clock reads.
 * The secret store itself (installation.key, 0700/0600, exclusive create)
 * lives in a separate module so this file stays unit-testable without a
 * filesystem.
 *
 * Invariants enforced here:
 * - Fingerprints are HMAC-SHA256(secret, canonical bytes) — never unkeyed
 *   hashes of credential material (§9.1).
 * - Canonical encoding is length-prefixed per field, so "missing" and
 *   "empty string" can never collide and values cannot forge separators.
 * - Request URLs are reduced to origin+path before entering identity;
 *   queries, fragments, userinfo never participate in hashing.
 * - JobKey derivation requires ALL components; a missing component is a
 *   programming error, not an implicit empty match (§3.3).
 * - HostInstanceToken is an opaque object: it must live inside nested Map
 *   keys and must never be serialized or String()-ified into logs.
 */

import { createHmac } from 'node:crypto'
import type {
  CredentialGenerationV1,
  SemanticInventoryIdentityV3,
} from './types'

export type { CredentialGenerationV1, SemanticInventoryIdentityV3 }

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------

/** Minimum entropy for the per-installation HMAC secret (plan §9.1: 32 bytes). */
const MIN_SECRET_BYTES = 32

/** Keyed-hash secret material. Callers pass decoded raw bytes. */
export type HmacSecret = Uint8Array

export function assertHmacSecret(secret: HmacSecret): void {
  if (!(secret instanceof Uint8Array)) {
    throw new TypeError('hmac secret must be Uint8Array bytes')
  }
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new RangeError(
      `hmac secret too weak: ${String(secret.byteLength)} bytes, need >= ${MIN_SECRET_BYTES}`,
    )
  }
}

function hmac(secret: HmacSecret, message: string): Buffer {
  assertHmacSecret(secret)
  return createHmac('sha256', Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength))
    .update(message, 'utf8')
    .digest()
}

/** Lowercase hex HMAC-SHA256 over UTF-8 bytes of `message`. */
export function hmacHex(secret: HmacSecret, message: string): string {
  return hmac(secret, message).toString('hex')
}

// ---------------------------------------------------------------------------
// Canonical encoding
// ---------------------------------------------------------------------------

export type CanonicalFieldValue = string | number | undefined

/**
 * Encodes fields as deterministic length-prefixed lines:
 *
 *   name=<byteLength>:<utf8 value>\n
 *
 * `undefined` fields are omitted entirely; empty strings encode as
 * `name=0:` — the two remain distinct by construction. Field order is the
 * object insertion order, so callers pass explicitly ordered literals.
 */
export function encodeCanonicalFields(
  fields: Record<string, CanonicalFieldValue>,
): string {
  let out = ''
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value as number) && typeof value === 'number') {
      throw new TypeError(`canonical field "${name}" must be a safe integer`)
    }
    const s = typeof value === 'number' ? String(value) : value
    out += `${name}=${Buffer.byteLength(s, 'utf8')}:${s}\n`
  }
  return out
}

// ---------------------------------------------------------------------------
// URL redaction
// ---------------------------------------------------------------------------

/**
 * Reduces a request URL to `origin + pathname`. Returns `undefined` when the
 * input cannot be parsed as an absolute http(s) URL. Query, fragment, auth
 * and port-normalized origins never enter identity strings.
 */
export function redactRequestUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Semantic identity hash / semantic inventory key
// ---------------------------------------------------------------------------

/**
 * The stable cache-space key: HMAC over every SemanticInventoryIdentityV3
 * field in a fixed order. Any field difference — including adapter version,
 * region, workspace fingerprints or request vary — yields a different key,
 * which is what isolates Key A from Key B at the storage layer (§16.1).
 */
export function computeSemanticIdentityHash(
  secret: HmacSecret,
  identity: SemanticInventoryIdentityV3,
): string {
  const canonical = encodeCanonicalFields({
    v: 3,
    providerId: identity.providerId,
    adapterId: identity.adapterId,
    adapterVersion: identity.adapterVersion,
    url: identity.canonicalRequestUrlRedacted,
    semantics: identity.visibilitySemantics,
    scope: identity.visibilityScope,
    runtimeAuthKind: identity.runtimeAuth.kind,
    runtimeAuthType: identity.runtimeAuth.credentialType,
    runtimeIdentityKind: identity.runtimeAuth.identityKind,
    runtimeIdentityFingerprint: identity.runtimeAuth.identityFingerprint,
    cpAuthType: identity.controlPlaneAuth?.credentialType,
    cpIdentityKind: identity.controlPlaneAuth?.identityKind,
    cpIdentityFingerprint: identity.controlPlaneAuth?.identityFingerprint,
    cpAccountFingerprint: identity.controlPlaneAuth?.accountFingerprint,
    cpProjectFingerprint: identity.controlPlaneAuth?.projectFingerprint,
    region: identity.region,
    partition: identity.partition,
    orgFingerprint: identity.organizationFingerprint,
    workspaceFingerprint: identity.workspaceFingerprint,
    projectFingerprint: identity.projectFingerprint,
    subscriptionResourceFingerprint: identity.subscriptionResourceFingerprint,
    requestVary: identity.requestVaryFingerprint,
    apiSurface: identity.apiSurface,
  })
  return hmacHex(secret, `semantic-identity-v3\n${canonical}`)
}

// ---------------------------------------------------------------------------
// Credential generation hash
// ---------------------------------------------------------------------------

/**
 * Hashes the resolved credential material generation. Distinct tokens of the
 * same principal produce distinct generations; only exact equality shares
 * jobs and singleflight slots (§3.3).
 */
export function computeCredentialGenerationHash(
  secret: HmacSecret,
  generation: CredentialGenerationV1,
): string {
  const canonical = encodeCanonicalFields({
    v: 1,
    runtimeMaterial: generation.runtimeMaterialFingerprint,
    runtimeVersion: generation.runtimeMaterialVersion,
    controlPlaneMaterial: generation.controlPlaneMaterialFingerprint,
    controlPlaneVersion: generation.controlPlaneMaterialVersion,
  })
  return hmacHex(secret, `credential-generation-v1\n${canonical}`)
}

// ---------------------------------------------------------------------------
// JobKey composition
// ---------------------------------------------------------------------------

export interface JobKeyParts {
  semanticIdentityHash: string
  /** Sorted set of active generation hashes (runtime + optional control plane). */
  credentialGenerationHashes: readonly string[]
  /** Already-fingerprinted vary material (never raw header/query values). */
  requestVaryFingerprint: string
  adapterId: string
  adapterVersion: number
}

/**
 * Derives the singleflight job key. Only byte-identical requests share a
 * job; every component is mandatory — passing an empty generation list or
 * blank hashes throws instead of silently widening the match.
 */
export function deriveJobKey(secret: HmacSecret, parts: JobKeyParts): string {
  if (parts.semanticIdentityHash.length === 0) {
    throw new TypeError('deriveJobKey: semanticIdentityHash is required')
  }
  if (parts.credentialGenerationHashes.length === 0) {
    throw new TypeError('deriveJobKey: at least one credential generation is required')
  }
  for (const g of parts.credentialGenerationHashes) {
    if (g.length === 0) throw new TypeError('deriveJobKey: generation hash must be non-empty')
  }
  if (parts.requestVaryFingerprint.length === 0) {
    throw new TypeError('deriveJobKey: requestVaryFingerprint is required')
  }
  if (parts.adapterId.length === 0) {
    throw new TypeError('deriveJobKey: adapterId is required')
  }
  const sortedGenerations = [...parts.credentialGenerationHashes].sort()
  const canonical = encodeCanonicalFields({
    semantic: parts.semanticIdentityHash,
    generations: sortedGenerations.join(','),
    vary: parts.requestVaryFingerprint,
    adapter: parts.adapterId,
    adapterVersion: parts.adapterVersion,
  })
  return hmacHex(secret, `job-key-v1\n${canonical}`)
}

// ---------------------------------------------------------------------------
// Consumer keys and opaque host instance tokens
// ---------------------------------------------------------------------------

/**
 * Runtime brand symbol. It must be a real binding, not `declare const`: a
 * declared-only symbol is erased during type-stripping, so computed keys
 * referencing it throw ReferenceError at runtime.
 */
const hostInstanceTokenBrand: unique symbol = Symbol('HostInstanceToken')

/**
 * Opaque, non-serializable token identifying one V2 Scope / V1 plugin
 * instance. Consumers must keep these as nested Map keys and MUST NOT call
 * String() on them or persist them (§3.3).
 */
export interface HostInstanceToken {
  readonly [hostInstanceTokenBrand]: 'HostInstanceToken'
  /**
   * Monotonic per-process sequence. Reference identity remains authoritative,
   * but embedding a distinguishing value also defeats structural comparators
   * (toEqual / Object.keys snapshots) from collapsing two distinct instances.
   */
  readonly seq: number
}

let hostTokenCounter = 0

export function createHostInstanceToken(): HostInstanceToken {
  hostTokenCounter += 1
  const seq = hostTokenCounter
  // Explicit annotation keeps the brand literal narrow (computed symbol keys
  // widen to `string` without a contextual type).
  const token: HostInstanceToken = { [hostInstanceTokenBrand]: 'HostInstanceToken', seq }
  return Object.freeze(token)
}

export type BackendKind = 'v1' | 'v2-effect' | 'v2-promise'

/**
 * Identifies one projection consumer WITHOUT depending on V2-private
 * location/workspace APIs and WITHOUT plan hashes (§3.3). Plan changes bump
 * PlanGeneration on the same consumer instead of creating new ones.
 */
export interface ConsumerKey {
  readonly host: HostInstanceToken
  readonly backendKind: BackendKind
  /** Stable within the instance: usually the configured provider ID. */
  readonly logicalProviderSlot: string
}

export function createConsumerKey(
  host: HostInstanceToken,
  backendKind: BackendKind,
  logicalProviderSlot: string,
): ConsumerKey {
  if (logicalProviderSlot.length === 0) {
    throw new TypeError('consumer key requires a non-empty logical provider slot')
  }
  return Object.freeze({ host, backendKind, logicalProviderSlot })
}

/** Monotonic per-consumer plan counter (managed<->native switches etc.). */
export type PlanGeneration = number

export function nextPlanGeneration(current: PlanGeneration): PlanGeneration {
  if (!Number.isSafeInteger(current) || current < 0) {
    throw new TypeError('plan generation must be a non-negative safe integer')
  }
  return current + 1
}

// ---------------------------------------------------------------------------
// Diagnostic redaction
// ---------------------------------------------------------------------------

export interface RedactedIdentitySummary {
  providerId: string
  adapterId: string
  visibilitySemantics: string
  visibilityScope: string
  region?: string
  apiSurface: string
  runtimeAuthKind: string
  controlPlanePresent: boolean
}

/**
 * Safe diagnostic view: contains no fingerprints, no identity hashes, no URL
 * fragments beyond what redactRequestUrl already removed upstream, and no
 * account/workspace identifiers (§9.1 diagnostics rule). Callers that need
 * more detail must go through the audit CLI, which has its own redaction.
 */
export function redactIdentityForDiagnostics(
  identity: SemanticInventoryIdentityV3,
): RedactedIdentitySummary {
  return {
    providerId: identity.providerId,
    adapterId: identity.adapterId,
    visibilitySemantics: identity.visibilitySemantics,
    visibilityScope: identity.visibilityScope,
    region: identity.region,
    apiSurface: identity.apiSurface,
    runtimeAuthKind: identity.runtimeAuth.kind,
    controlPlanePresent: identity.controlPlaneAuth !== undefined,
  }
}
