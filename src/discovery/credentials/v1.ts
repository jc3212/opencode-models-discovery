/**
 * V1 inference credential resolution (v3 plan §9.3).
 *
 * Freezes the discovery-key precedence so the CLI and runtime share one
 * resolver and the discovered key is ALWAYS the key OpenCode actually uses
 * for inference:
 *
 *   1. explicit `provider.<id>.options.apiKey` (resolved plain string)
 *   2. `OPENCODE_AUTH_CONTENT` host-injected auth content
 *   3. host auth store (`<xdgData>/<client>/auth.json`) via injected reader
 *   4. adapter-declared environment variable names (`provider.env`)
 *
 * Anything that cannot be reproduced offline — OAuth entries, dynamic
 * loaders — resolves to UNRESOLVED instead of triggering a token refresh:
 * the startup critical path must never perform network work to learn its
 * own identity (§9.3). Callers translate `unresolved` into
 * `UNRESOLVED_DENY` (strict empty, explicit items only) per §3.2.
 *
 * Purity contract: no `process.env`, no filesystem access here — both are
 * injected through {@link CredentialLookupDeps} so tests pin every branch
 * and diagnostics can never accidentally leak real values.
 */

export type ResolvedCredentialSource =
  | 'explicit-options'
  | 'auth-content-env'
  | 'host-auth-store'
  | 'provider-env'

export interface ResolvedInferenceCredential {
  kind: 'resolved'
  providerId: string
  source: ResolvedCredentialSource
  /** Raw credential material. NEVER log, persist, or fingerprint directly. */
  material: string
  /**
   * Safe diagnostic descriptor (e.g. `env:DASHSCOPE_API_KEY`,
   * `auth-store:<clientId>`). Guaranteed free of the material itself.
   */
  detail: string
}

export type UnresolvedCredentialReason = 'no-credential' | 'oauth-entry' | 'invalid-entry'

export interface UnresolvedCredential {
  kind: 'unresolved'
  providerId: string
  reason: UnresolvedCredentialReason
}

export type CredentialResolution = ResolvedInferenceCredential | UnresolvedCredential

export interface CredentialLookupDeps {
  /** Environment snapshot; defaults to empty (tests stay hermetic). */
  env?: Record<string, string | undefined>
  /**
   * Reads the parsed host auth store mapping provider ids to entries.
   * Absent or throwing readers simply yield nothing.
   */
  readHostAuthStore?: () => Record<string, unknown> | undefined
}

export interface ResolveInferenceCredentialInput {
  providerId: string
  /** Raw `options.apiKey` value exactly as configured (may be junk). */
  explicitApiKey?: unknown
  /** Adapter-official environment variable names, in priority order. */
  providerEnvNames?: readonly string[]
  deps?: CredentialLookupDeps
}

interface AuthEntry {
  type?: unknown
  key?: unknown
}

function normalizeProviderId(providerId: string): string {
  return providerId.replace(/\/+$/, '')
}

/** Provider-id lookup variants kept compatible with the host auth format. */
function authKeyVariants(providerId: string): string[] {
  const normalized = normalizeProviderId(providerId)
  return [providerId, normalized, `${normalized}/`]
    .filter((variant, index, all) => all.indexOf(variant) === index)
}

function usableApiKey(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const candidate = entry as AuthEntry
  if (candidate.type !== 'api') return undefined
  if (typeof candidate.key !== 'string') return undefined
  const trimmed = candidate.key.trim()
  return trimmed.length > 0 ? candidate.key : undefined
}

function parseJsonMap(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return undefined
  } catch {
    return undefined
  }
}

function findAuthEntry(
  map: Record<string, unknown> | undefined,
  providerId: string,
): { entry: unknown; variant: string } | undefined {
  if (!map) return undefined
  for (const variant of authKeyVariants(providerId)) {
    if (variant in map) return { entry: map[variant], variant }
  }
  return undefined
}

/**
 * Resolves the inference credential for one provider under the frozen V1
 * precedence. Never throws for missing data — absence is an outcome
 * (`kind: 'unresolved'`), not an error.
 */
export function resolveInferenceCredentialV1(
  input: ResolveInferenceCredentialInput,
): CredentialResolution {
  const { providerId } = input

  // 1. Explicit options.apiKey — must be a resolved plain string.
  if (typeof input.explicitApiKey === 'string' && input.explicitApiKey.trim().length > 0) {
    return {
      kind: 'resolved',
      providerId,
      source: 'explicit-options',
      material: input.explicitApiKey,
      detail: 'options.apiKey',
    }
  }

  const env = input.deps?.env ?? {}
  const readHostAuthStore = input.deps?.readHostAuthStore

  // 2./3. Host auth content (env override first, then the on-disk store).
  const sources: Array<{ name: 'auth-content-env' | 'host-auth-store'; map: Record<string, unknown> | undefined }> = [
    { name: 'auth-content-env', map: parseJsonMap(env.OPENCODE_AUTH_CONTENT) },
  ]
  if (readHostAuthStore) {
    let storeMap: Record<string, unknown> | undefined
    try {
      storeMap = readHostAuthStore()
    } catch {
      storeMap = undefined
    }
    sources.push({ name: 'host-auth-store', map: storeMap })
  }

  let sawUnusable = false
  for (const source of sources) {
    const hit = findAuthEntry(source.map, providerId)
    if (!hit) continue
    const material = usableApiKey(hit.entry)
    if (material) {
      return {
        kind: 'resolved',
        providerId,
        source: source.name,
        material,
        detail: `${source.name}:${hit.variant}`,
      }
    }
    sawUnusable = true
  }

  // 4. Adapter-official environment variables, in declared order.
  for (const envName of input.providerEnvNames ?? []) {
    const value = env[envName]
    if (typeof value === 'string' && value.trim().length > 0) {
      return {
        kind: 'resolved',
        providerId,
        source: 'provider-env',
        material: value,
        detail: `env:${envName}`,
      }
    }
  }

  if (sawUnusable) {
    // An auth entry existed but was OAuth/dynamic or malformed: resolving
    // it would require network token refresh, which setup must not do.
    const reason: UnresolvedCredentialReason = sawUnusable ? 'oauth-entry' : 'no-credential'
    return { kind: 'unresolved', providerId, reason }
  }
  return { kind: 'unresolved', providerId, reason: 'no-credential' }
}
