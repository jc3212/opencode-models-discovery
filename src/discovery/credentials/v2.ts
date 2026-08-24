/**
 * V2 connection credential boundary (v3 plan §3.2, §3.3, §9.3).
 *
 * OpenCode's public V2 API does not guarantee a connection event or a
 * setup-time token refresh. This module therefore defines an injectable
 * resolver boundary rather than importing a private host API:
 *
 * - `setup-local` is a local-only phase. The supplied resolver must not
 *   refresh OAuth or perform network I/O in this phase.
 * - `background` is the only phase where a host adapter may resolve an
 *   expiring connection. The caller owns the Effect Scope and cancellation.
 * - A descriptor without usable material is `unresolved`; a stable principal
 *   alone does not prove that an inference token is currently usable.
 *
 * Raw material is returned only as transient data for the caller to HMAC and
 * build a JobKey. This module never persists or logs it.
 */

export type V2CredentialPhase = 'setup-local' | 'background'
export type V2CredentialKind = 'api' | 'oauth' | 'none'

export interface V2ConnectionDescriptor {
  providerId: string
  credentialKind: V2CredentialKind
  credentialType?: string
  /** Current runtime credential material, transient only. */
  material?: string
  /** Stable principal only when the host contract proves it. */
  stablePrincipal?: string
  /** Host-provided token/generation revision, never the token itself. */
  materialVersion?: string
  /** Safe source label, such as `local-connection-cache`. */
  source?: string
}

export interface V2CredentialResolverDeps {
  /**
   * The host adapter decides whether a phase may use network. The resolver
   * passes the phase explicitly so a test or adapter can reject accidental
   * setup-time refreshes.
   */
  resolveConnection: (
    providerId: string,
    phase: V2CredentialPhase,
  ) => Promise<V2ConnectionDescriptor | undefined>
}

export interface ResolveV2CredentialInput {
  providerId: string
  phase: V2CredentialPhase
}

export interface ResolvedV2Credential {
  kind: 'resolved'
  providerId: string
  credentialKind: Exclude<V2CredentialKind, 'none'>
  credentialType: string
  material: string
  identityKind: 'material' | 'stable-principal'
  stablePrincipal?: string
  materialVersion?: string
  source: string
}

export type V2UnresolvedReason =
  | 'connection-unavailable'
  | 'credential-disabled'
  | 'material-unavailable'
  | 'invalid-descriptor'

export interface UnresolvedV2Credential {
  kind: 'unresolved'
  providerId: string
  reason: V2UnresolvedReason
}

export type V2CredentialResolution = ResolvedV2Credential | UnresolvedV2Credential

function safeSource(value: string | undefined): string {
  if (!value || !/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(value)) return 'host-connection'
  return value
}

function validDescriptor(
  descriptor: V2ConnectionDescriptor,
  providerId: string,
): boolean {
  return descriptor.providerId === providerId &&
    (descriptor.credentialKind === 'api' || descriptor.credentialKind === 'oauth' || descriptor.credentialKind === 'none')
}

/** Resolves one V2 descriptor without choosing a host-private API. */
export async function resolveInferenceCredentialV2(
  input: ResolveV2CredentialInput,
  deps: V2CredentialResolverDeps,
): Promise<V2CredentialResolution> {
  let descriptor: V2ConnectionDescriptor | undefined
  try {
    descriptor = await deps.resolveConnection(input.providerId, input.phase)
  } catch {
    return { kind: 'unresolved', providerId: input.providerId, reason: 'connection-unavailable' }
  }
  if (!descriptor) {
    return { kind: 'unresolved', providerId: input.providerId, reason: 'connection-unavailable' }
  }
  if (!validDescriptor(descriptor, input.providerId)) {
    return { kind: 'unresolved', providerId: input.providerId, reason: 'invalid-descriptor' }
  }
  if (descriptor.credentialKind === 'none') {
    return { kind: 'unresolved', providerId: input.providerId, reason: 'credential-disabled' }
  }
  if (typeof descriptor.material !== 'string' || descriptor.material.trim().length === 0) {
    return { kind: 'unresolved', providerId: input.providerId, reason: 'material-unavailable' }
  }

  const identityKind = descriptor.stablePrincipal ? 'stable-principal' : 'material'
  return {
    kind: 'resolved',
    providerId: input.providerId,
    credentialKind: descriptor.credentialKind,
    credentialType: descriptor.credentialType ?? descriptor.credentialKind,
    material: descriptor.material,
    identityKind,
    ...(descriptor.stablePrincipal ? { stablePrincipal: descriptor.stablePrincipal } : {}),
    ...(descriptor.materialVersion ? { materialVersion: descriptor.materialVersion } : {}),
    source: safeSource(descriptor.source),
  }
}
