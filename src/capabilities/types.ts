/**
 * Capability evidence contracts (v3 plan §10.1/§10.2; E4 frozen types).
 *
 * Reasoning capability evidence is deliberately separate from access
 * evidence (§5 AccessEvidence solves the callable set FIRST; capability
 * evidence binds to exact eligible routes afterwards). One evidence record
 * carries exactly ONE atomic claim with its own support+completeness.
 *
 * Every atomic claim owns an independent schema. Evidence carrying a field
 * incompatible with its claim is REJECTED by the validator, never ignored
 * silently (§10.3).
 */

export type SupportState = 'unknown' | 'supported' | 'unsupported'
export type Completeness = 'unknown' | 'partial' | 'exhaustive'
export type EffectiveEffort = 'minimal' | 'low' | 'medium' | 'high' | 'max'

/** Exact route/scope binding; hashes and fingerprints only, never secrets. */
export interface EvidenceScope {
  inventoryIdentityHash: string
  routeKey: string
  providerKind: string
  origin: string
  region?: string
  principalFingerprint?: string
  workspaceOrProjectFingerprint?: string
  remoteModelId: string
  deploymentId?: string
  canonicalModelId?: string
  modelRevision?: string
  /** `unknown` when the source declares none; never guessed from call shape. */
  apiSurface: string
  transportPackageAndVersion?: string
  routePolicyFingerprint?: string
}

export type ReasoningAtomicClaim =
  | 'canonical.identity'
  | 'reasoning.support'
  | 'effort.accepted'
  | 'effort.effective'
  | 'effort.normalization'
  | 'effort.default'
  | 'reasoning.mandatory'
  | 'toggle'
  | 'budget.range'
  | 'transport.wire'

export type ClaimAuthority = 'exact' | 'high' | 'medium' | 'low'

export interface ReasoningCapabilityEvidence {
  claim: ReasoningAtomicClaim
  scope: EvidenceScope
  support: SupportState
  completeness: Completeness
  values?: string[]
  normalization?: Record<string, EffectiveEffort | 'none'>
  preferredWireByEffective?: Partial<Record<EffectiveEffort, string>>
  negativeValues?: string[]
  scalar?: string | boolean | number
  budgetRange?: { min?: number; max?: number; default?: number }
  authority: ClaimAuthority
  source: {
    id: string
    url?: string
    revision?: string
    observedAt?: string
    receivedAt: string
    activatedAt: string
  }
}

/**
 * Which optional payload fields are semantically compatible with each
 * atomic claim. Anything outside this set makes the record invalid.
 */
export const CLAIM_ALLOWED_FIELDS: Readonly<
  Record<ReasoningAtomicClaim, readonly string[]>
> = Object.freeze({
  'canonical.identity': ['scalar'],
  'reasoning.support': [],
  'effort.accepted': ['values', 'negativeValues'],
  'effort.effective': ['values', 'negativeValues'],
  'effort.normalization': ['normalization', 'preferredWireByEffective'],
  'effort.default': ['scalar'],
  'reasoning.mandatory': ['scalar'],
  toggle: ['values', 'scalar', 'negativeValues'],
  'budget.range': ['budgetRange'],
  'transport.wire': ['preferredWireByEffective', 'values', 'scalar'],
})

const SUPPORT_STATES = new Set<string>(['unknown', 'supported', 'unsupported'])
const COMPLETENESS = new Set<string>(['unknown', 'partial', 'exhaustive'])
const AUTHORITIES = new Set<string>(['exact', 'high', 'medium', 'low'])
const EFFECTIVE_EFFORTS = new Set<string>(['minimal', 'low', 'medium', 'high', 'max'])

export type EvidenceValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

function reject(reason: string): EvidenceValidationResult {
  return { ok: false, reason }
}

function requireNonEmpty(value: unknown, field: string): EvidenceValidationResult {
  if (typeof value !== 'string' || value.length === 0) return reject(`${field} must be a non-empty string`)
  return { ok: true }
}

/**
 * Validates one evidence record against its claim schema. Fail-closed:
 * structural surprises reject the whole record instead of dropping fields.
 */
export function validateReasoningCapabilityEvidence(
  evidence: ReasoningCapabilityEvidence,
): EvidenceValidationResult {
  if (!evidence || typeof evidence !== 'object') return reject('evidence must be an object')

  const claimCheck = requireNonEmpty(evidence.claim, 'claim')
  if (!claimCheck.ok) return claimCheck
  if (!(evidence.claim in CLAIM_ALLOWED_FIELDS)) {
    return reject(`unknown atomic claim "${evidence.claim}"`)
  }

  // Scope sanity: identity binding fields are mandatory.
  if (!evidence.scope || typeof evidence.scope !== 'object') return reject('scope is required')
  if (!/^[0-9a-f]{64}$/.test(evidence.scope.inventoryIdentityHash)) {
    return reject('scope.inventoryIdentityHash must be a 64-char lowercase hex hash')
  }
  for (const field of ['routeKey', 'providerKind', 'origin', 'remoteModelId', 'apiSurface'] as const) {
    const check = requireNonEmpty(evidence.scope[field], `scope.${field}`)
    if (!check.ok) return check
  }

  if (!SUPPORT_STATES.has(evidence.support)) return reject(`invalid support "${String(evidence.support)}"`)
  if (!COMPLETENESS.has(evidence.completeness)) {
    return reject(`invalid completeness "${String(evidence.completeness)}"`)
  }
  if (!AUTHORITIES.has(evidence.authority)) {
    return reject(`invalid authority "${String(evidence.authority)}"`)
  }

  // Payload fields outside the claim's schema are rejected outright (§10.3).
  const allowed = CLAIM_ALLOWED_FIELDS[evidence.claim]
  const payloadFields: Array<[string, unknown]> = [
    ['values', evidence.values],
    ['normalization', evidence.normalization],
    ['preferredWireByEffective', evidence.preferredWireByEffective],
    ['negativeValues', evidence.negativeValues],
    ['scalar', evidence.scalar],
    ['budgetRange', evidence.budgetRange],
  ]
  for (const [field, value] of payloadFields) {
    if (value === undefined) continue
    if (!allowed.includes(field)) {
      return reject(`field "${field}" is incompatible with claim "${evidence.claim}"`)
    }
  }

  if (evidence.values !== undefined) {
    if (!Array.isArray(evidence.values) || evidence.values.some((v) => typeof v !== 'string')) {
      return reject('values must be an array of strings')
    }
  }
  if (evidence.negativeValues !== undefined) {
    if (
      !Array.isArray(evidence.negativeValues) ||
      evidence.negativeValues.some((v) => typeof v !== 'string')
    ) {
      return reject('negativeValues must be an array of strings')
    }
    if (evidence.completeness === 'exhaustive' && evidence.support === 'supported') {
      // Negative values alongside an exhaustive positive set is contradictory.
      return reject('negativeValues contradict an exhaustive supported set')
    }
  }
  if (evidence.normalization !== undefined) {
    if (evidence.normalization === null || typeof evidence.normalization !== 'object') {
      return reject('normalization must be an object')
    }
    for (const [from, to] of Object.entries(evidence.normalization)) {
      if (typeof from !== 'string' || from.length === 0) return reject('normalization keys must be non-empty strings')
      if (to !== 'none' && !EFFECTIVE_EFFORTS.has(to)) {
        return reject(`normalization target "${String(to)}" is not an effective effort or "none"`)
      }
    }
  }
  if (evidence.preferredWireByEffective !== undefined) {
    if (evidence.preferredWireByEffective === null || typeof evidence.preferredWireByEffective !== 'object') {
      return reject('preferredWireByEffective must be an object')
    }
    for (const [effort, wire] of Object.entries(evidence.preferredWireByEffective)) {
      if (!EFFECTIVE_EFFORTS.has(effort)) return reject(`preferredWire key "${effort}" is not an effective effort`)
      if (typeof wire !== 'string' || wire.length === 0) {
        return reject(`preferredWire value for "${effort}" must be a non-empty string`)
      }
    }
  }
  if (evidence.budgetRange !== undefined) {
    if (evidence.budgetRange === null || typeof evidence.budgetRange !== 'object') {
      return reject('budgetRange must be an object')
    }
    const { min, max, default: dflt } = evidence.budgetRange
    for (const [name, value] of [['min', min], ['max', max], ['default', dflt]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        return reject(`budgetRange.${name} must be a non-negative finite number`)
      }
    }
    if (min !== undefined && max !== undefined && min > max) {
      return reject('budgetRange.min exceeds budgetRange.max')
    }
  }

  // Source provenance is mandatory.
  if (!evidence.source || typeof evidence.source !== 'object') return reject('source is required')
  const idCheck = requireNonEmpty(evidence.source.id, 'source.id')
  if (!idCheck.ok) return idCheck
  const receivedCheck = requireNonEmpty(evidence.source.receivedAt, 'source.receivedAt')
  if (!receivedCheck.ok) return receivedCheck
  const activatedCheck = requireNonEmpty(evidence.source.activatedAt, 'source.activatedAt')
  if (!activatedCheck.ok) return activatedCheck

  return { ok: true }
}
