/**
 * Frozen v3 discovery contracts (plan §4, §5.1, §8.1; WP0).
 *
 * These types are the stable vocabulary shared by the discovery engine,
 * adapters, cache v3, and future capability evidence system. They are pure
 * declarations: no runtime behavior, no I/O. Changing them after Gate 0
 * freeze requires an explicit contract review.
 */

// ---------------------------------------------------------------------------
// Inventory visibility contracts (§5.1)
// ---------------------------------------------------------------------------

export type VisibilitySemantics =
  | 'policy-filtered'
  | 'available-to-credential'
  | 'credential-observed'
  | 'deployment-scoped'
  | 'catalog'
  | 'non-enumerable'

export type VisibilityScope =
  | 'public'
  | 'account'
  | 'org'
  | 'project'
  | 'workspace'
  | 'credential'

export interface ProviderInventoryContract {
  adapterId: string
  adapterVersion: number
  recognition: { providerIds: string[]; exactOrigins: string[]; paths?: string[] }
  authKind: 'inference-key' | 'oauth' | 'control-plane' | 'none'
  visibilitySemantics: VisibilitySemantics
  visibilityScope: VisibilityScope
  endpoint: string
  pagination: 'none' | 'offset' | 'page-number' | 'token'
  /** A 200 response with an empty list is authoritative for this surface. */
  completeEmptyIsAuthoritative: boolean
  /**
   * True only when official contract documents current-identity filtering or
   * a dual-credential differential fixture proves it. An authenticated
   * request alone NEVER implies strict eligibility (§5.1).
   */
  strictEligible: boolean
}

export interface NormalizedInventoryModel {
  selectionKey: string
  effectiveRemoteApiId: string
  canonicalModelId?: string
  deploymentId?: string
  modelRevision?: string
  status?: string
  providerNativeMetadata?: Record<string, unknown>
}

export interface DiscoveredRoute {
  selectionKey: string
  /** The value actually used when sending requests. */
  invocationId: string
  routeKind: 'model-name' | 'deployment-id' | 'endpoint-id' | 'inference-profile' | 'resource-arn'
  canonicalModelId?: string
  deploymentId?: string
  readiness: 'ready' | 'not-ready' | 'unknown'
  maturity: 'stable' | 'experimental'
}

export interface AccessEvidence {
  inventoryIdentityHash: string
  routeKey: string
  claim: 'credential-visible' | 'account-authorized' | 'deployment-ready' | 'policy-eligible'
  state: 'allowed' | 'denied' | 'unknown'
  completeness: 'unknown' | 'partial' | 'exhaustive'
  source: { adapterId: string; endpoint: string; revision?: string; receivedAt: string }
}

// ---------------------------------------------------------------------------
// Orthogonal projection x refresh state machines (§4.1)
// ---------------------------------------------------------------------------

/**
 * What the plugin currently contributes to the host catalog. Strictly
 * separated from refresh activity — mixed states like `stale-refreshing`
 * are forbidden by design.
 */
export type ProjectionState =
  /** Do not touch the host catalog at all (Zen/Go, disabled, host-owned). */
  | 'no-contribution'
  /** Keep user-explicit/host-owned items; no automatic discovery claims. */
  | 'explicit-only'
  /** Credential could not be resolved locally: strict empty, explicit only. */
  | 'unresolved-deny'
  /** Complete projection for the exact semantic identity. */
  | 'fresh'
  /** Same-identity complete LKG within hard-stale window, marked stale. */
  | 'stale-allowed'
  /** Authoritative empty: identity switch without LKG, or hard-stale revoke. */
  | 'strict-empty'
  /** Current credential generation has a confirmed auth failure. */
  | 'auth-blocked'
  /** Terminal: no publication rights remain. */
  | 'disposed'

export type RefreshState =
  | 'idle'
  | 'scheduled'
  | 'refreshing'
  | 'backoff'
  | 'paused'
  | 'disposed'

export type RefreshOutcome =
  | 'complete-nonempty'
  | 'complete-empty'
  | 'not-modified'
  | 'partial'
  | 'invalid'

/**
 * Discriminated union of machine events (WP0 frozen contract). Payload
 * fields are declared per-member so consumers cannot attach irrelevant data
 * to an event, and the reducer gets exhaustive narrowing.
 */
export type DiscoveryEvent =
  | { type: 'PLAN_CHANGED' }
  | { type: 'CREDENTIAL_OBSERVED' }
  | { type: 'POST_SETUP_DEFERRED' }
  | { type: 'SOFT_TTL_DUE' }
  | {
      type: 'HARD_TTL_DUE'
      /** Inventory projection semantics driving empty/stale decisions. */
      semantics: 'strict' | 'observed'
    }
  | { type: 'CACHE_REVISION_CHANGED' }
  | { type: 'MANUAL_REFRESH' }
  /** Scheduler dispatched the singleflight job for this exact JobKey. */
  | { type: 'REFRESH_STARTED' }
  | {
      type: 'REFRESH_COMPLETE'
      outcome: RefreshOutcome
      semantics: 'strict' | 'observed'
      /**
       * True when a same-identity COMPLETE inventory exists and is still
       * inside its hard-stale window. Partial results never count as LKG.
       */
      hasValidLkg: boolean
    }
  | {
      type: 'TRANSIENT_FAILURE'
      semantics: 'strict' | 'observed'
      hasValidLkg: boolean
    }
  | {
      type: 'AUTH_ERROR'
      /**
       * True only when the adapter contract confirms the inference credential
       * identity itself failed. Enumeration-only rejections (403/404/405 on
       * the listing endpoint with a valid key) must NOT set this (§7.1).
       */
      confirmedIdentityAuthFailure: boolean
    }
  | { type: 'DISPOSE' }

export type DiscoveryEventType = DiscoveryEvent['type']

export interface DiscoveryMachineState {
  projection: ProjectionState
  refresh: RefreshState
}

// ---------------------------------------------------------------------------
// Semantic inventory identity and credential generations (plan §3.3, §9.2)
// ---------------------------------------------------------------------------

/**
 * The exact scope an inventory belongs to. Two consumers share a cache entry
 * ONLY when every field here is identical after normalization. Credential
 * material itself NEVER appears: it enters only as an HMAC fingerprint.
 */
export interface SemanticInventoryIdentityV3 {
  providerId: string
  adapterId: string
  adapterVersion: number
  /**
   * origin + path only. Query strings, fragments and userinfo are dropped
   * before hashing; sensitive request vary enters via requestVaryFingerprint.
   */
  canonicalRequestUrlRedacted: string
  visibilitySemantics: VisibilitySemantics
  visibilityScope: VisibilityScope
  runtimeAuth: {
    kind: 'public' | 'credential'
    credentialType?: string
    identityKind: 'public' | 'material' | 'stable-principal'
    identityFingerprint?: string
  }
  /**
   * Optional management-plane query identity. It describes candidates inside
   * the SAME semantic identity; it can never substitute the runtime auth.
   */
  controlPlaneAuth?: {
    credentialType: string
    identityKind: 'material' | 'stable-principal'
    identityFingerprint: string
    accountFingerprint?: string
    projectFingerprint?: string
  }
  region?: string
  partition?: string
  organizationFingerprint?: string
  workspaceFingerprint?: string
  projectFingerprint?: string
  subscriptionResourceFingerprint?: string
  /** Local HMAC over sorted sensitive headers/query values that vary results. */
  requestVaryFingerprint: string
  /** e.g. `chat-completions`, `responses`, `anthropic-messages`. */
  apiSurface: string
}

/**
 * Fingerprint of the current credential material actually resolved at
 * runtime. Not a principal, not plaintext; changes on every rotation even
 * when the stable principal does not. Old generations must never publish,
 * activate caches, or write tombstones for newer generations (§3.3).
 */
export interface CredentialGenerationV1 {
  runtimeMaterialFingerprint?: string
  runtimeMaterialVersion?: string
  controlPlaneMaterialFingerprint?: string
  controlPlaneMaterialVersion?: string
}
