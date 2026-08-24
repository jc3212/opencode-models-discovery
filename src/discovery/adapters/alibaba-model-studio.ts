/**
 * Alibaba Model Studio (DashScope) inventory adapter (v3 plan §7.3, WP3).
 *
 * Beijing workspace chain with a standard key:
 * 1. `GET /api/v1/models/permissions?authorization_scope=AUTHORIZED&action=INFERENCE`
 *    → the workspace-authorized inference set.
 * 2. `GET /api/v1/models` → metadata ONLY; it can never add routes for IDs
 *    absent from the authorized set.
 * 3. Optional `GET /api/v1/deployments` → RUNNING deployments become
 *    deployment-id route candidates marked experimental. They are
 *    workspace-observed and can never expand the strict set on their own.
 *
 * Gate 0 status: the All-key vs Custom-key differential has NOT been run,
 * so permissions semantics are conservatively downgraded to
 * workspace-filtered (`credential-observed`, strictEligible=false). Other
 * regions only get the plain authenticated `/api/v1/models` list until
 * their permission endpoints are officially published.
 */

import type { FetchLike } from '../http-client'
import { executeAdapterRequest } from './generic-openai'
import type { ProviderInventoryContract } from '../types'
import {
  parseModelListEnvelope,
  routesFromEntries,
  type InventoryFetchResult,
} from './shared'

export const ALIBABA_MODEL_STUDIO_ADAPTER_ID = 'alibaba-model-studio' as const
export const ALIBABA_MODEL_STUDIO_ADAPTER_VERSION = 1

export const BEIJING_ORIGIN = 'https://dashscope.aliyuncs.com' as const
/** Regions whose permission/deployment APIs are NOT officially published. */
export const MODELS_ONLY_ORIGINS: readonly string[] = [
  BEIJING_ORIGIN,
  'https://dashscope-intl.aliyuncs.com',
]

const OFFICIAL_ORIGINS = new Set<string>(MODELS_ONLY_ORIGINS)

export function isAlibabaStudioOfficialOrigin(baseUrl: unknown): baseUrl is string {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return false
  try {
    const url = new URL(baseUrl.trim())
    return url.protocol === 'https:' && OFFICIAL_ORIGINS.has(url.origin)
  } catch {
    return false
  }
}

function originOf(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim())
    return OFFICIAL_ORIGINS.has(url.origin) ? url.origin : undefined
  } catch {
    return undefined
  }
}

export interface AlibabaStudioAdapterConfig {
  baseUrl: string
  apiKey?: string
  workspaceId?: string
  includeDeployments?: boolean
  headers?: Record<string, string>
  signal?: AbortSignal
}

export function alibabaModelStudioContract(config?: { region?: 'cn-beijing' | string }): ProviderInventoryContract {
  return {
    adapterId: ALIBABA_MODEL_STUDIO_ADAPTER_ID,
    adapterVersion: ALIBABA_MODEL_STUDIO_ADAPTER_VERSION,
    recognition: {
      providerIds: ['dashscope', 'alibaba-model-studio'],
      exactOrigins: [...MODELS_ONLY_ORIGINS],
    },
    authKind: 'inference-key',
    visibilitySemantics: 'credential-observed',
    visibilityScope: config?.region === 'cn-beijing' ? 'workspace' : 'credential',
    endpoint: '/api/v1/models/permissions',
    pagination: 'none',
    completeEmptyIsAuthoritative: false,
    // Workspace-filtered only until the Custom-key differential proves
    // per-Key scoping (Gate 0, §7.3).
    strictEligible: false,
  }
}

interface PermissionEntryResult {
  ids: string[]
  malformedCount: number
}

/**
 * Conservative parser for the permissions payload. The live schema is not
 * fixture-frozen yet, so extraction accepts only an array under `data`
 * whose entries carry one of the allowlisted id fields; anything else
 * counts as malformed and degrades the result to partial/invalid.
 */
export function parsePermissionEntries(json: unknown): PermissionEntryResult | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const ID_FIELDS = ['model_name', 'name', 'model', 'id'] as const
  const ids: string[] = []
  let malformedCount = 0
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') {
      malformedCount += 1
      continue
    }
    const record = entry as Record<string, unknown>
    const id = ID_FIELDS.map((field) => record[field]).find(
      (value) => typeof value === 'string' && value.length > 0,
    )
    if (typeof id === 'string') ids.push(id)
    else malformedCount += 1
  }
  return { ids, malformedCount }
}

interface DeploymentEntryResult {
  deployments: { id: string; status?: string; modelId?: string }[]
  malformedCount: number
}

/** Conservative parser for the deployments payload (same discipline). */
export function parseDeploymentEntries(json: unknown): DeploymentEntryResult | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined
  const data = (json as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const ID_FIELDS = ['deployment_id', 'endpoint', 'id'] as const
  const deployments: { id: string; status?: string; modelId?: string }[] = []
  let malformedCount = 0
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') {
      malformedCount += 1
      continue
    }
    const record = entry as Record<string, unknown>
    const id = ID_FIELDS.map((field) => record[field]).find(
      (value) => typeof value === 'string' && value.length > 0,
    )
    if (typeof id !== 'string') {
      malformedCount += 1
      continue
    }
    const modelId = [record.model, record.base_model, record.model_id].find(
      (value) => typeof value === 'string' && value.length > 0,
    )
    deployments.push({
      id,
      ...(typeof record.status === 'string' ? { status: record.status } : {}),
      ...(typeof modelId === 'string' ? { modelId } : {}),
    })
  }
  return { deployments, malformedCount }
}

function invalid(reason: string): InventoryFetchResult {
  return { kind: 'invalid', routes: [], reason, authTombstoneEligible: false, enumerationUnsupported: false }
}

async function fetchAuthorizedIds(
  base: string,
  apiKey: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult & { authorizedIds?: string[] }> {
  const url = `${base}/models/permissions?authorization_scope=AUTHORIZED&action=INFERENCE`
  const outcome = await executeAdapterRequest(
    { url, headers: { ...headers, authorization: `Bearer ${apiKey}` }, ...(signal !== undefined ? { signal } : {}) },
    'inference-surface',
    fetchImpl,
  )
  if ('kind' in outcome) return outcome
  const parsed = parsePermissionEntries(outcome.json)
  if (!parsed) return invalid('permissions-schema-mismatch')
  if (parsed.malformedCount > 0) {
    return { kind: 'partial', routes: [], reason: `malformed-permissions:${parsed.malformedCount}`, authTombstoneEligible: false, enumerationUnsupported: false }
  }
  return { kind: 'complete', routes: [], reason: 'permissions-ok', authTombstoneEligible: false, enumerationUnsupported: false, authorizedIds: [...new Set(parsed.ids)].sort() }
}

/**
 * Executes the frozen Beijing chain (or the models-only fallback for other
 * official regions). Zero network on non-official origins or missing keys.
 */
export async function fetchAlibabaModelStudioInventory(
  config: AlibabaStudioAdapterConfig,
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  if (!isAlibabaStudioOfficialOrigin(config.baseUrl)) return invalid('non-official-origin')
  if (!config.apiKey || config.apiKey.length === 0) return invalid('missing-credentials')
  const origin = originOf(config.baseUrl)
  if (!origin) return invalid('invalid-base-url')
  const headers: Record<string, string> = { accept: 'application/json', ...config.headers }
  if (config.workspaceId) headers['X-DashScope-WorkspaceId'] = config.workspaceId
  const base = `${origin}/api/v1`

  const isBeijing = origin === BEIJING_ORIGIN

  let authorizedIds: string[] | undefined
  if (isBeijing) {
    const permissions = await fetchAuthorizedIds(base, config.apiKey, headers, config.signal, fetchImpl)
    if (permissions.kind !== 'complete' || !permissions.authorizedIds) return permissions
    authorizedIds = permissions.authorizedIds
  }

  const modelsOutcome = await executeAdapterRequest(
    { url: `${base}/models`, headers: { ...headers, authorization: `Bearer ${config.apiKey}` }, ...(config.signal !== undefined ? { signal: config.signal } : {}) },
    'inference-surface',
    fetchImpl,
  )
  if ('kind' in modelsOutcome) return modelsOutcome
  const catalogParsed = parseModelListEnvelope(modelsOutcome.json)
  if (!catalogParsed) return invalid('catalog-schema-mismatch')

  // Join: the authorized set bounds visibility; catalog entries can never
  // add routes for IDs outside it. Metadata enrichment beyond identity is
  // the capability/metadata layer's job, not this adapter's.
  const knownCatalogIds = new Set(catalogParsed.entries.map((entry) => String(entry.id)))
  const effective = authorizedIds ?? [...knownCatalogIds]
  if (effective.length === 0) {
    // An authoritative empty authorized-set is a legitimate complete-empty;
    // a plain empty catalog page is treated the same way here.
    return { kind: 'complete', routes: [], reason: 'authorized-empty', authTombstoneEligible: false, enumerationUnsupported: false }
  }

  const routes = effective.map((id) => ({
    selectionKey: id,
    invocationId: id,
    routeKind: 'model-name' as const,
    readiness: 'ready' as const,
    maturity: 'stable' as const,
  }))

  let deploymentRoutes: InventoryFetchResult['routes'] = []
  let deploymentMalformed = 0
  if (isBeijing && config.includeDeployments) {
    const depOutcome = await executeAdapterRequest(
      { url: `${base}/deployments`, headers: { ...headers, authorization: `Bearer ${config.apiKey}` }, ...(config.signal !== undefined ? { signal: config.signal } : {}) },
      'inference-surface',
      fetchImpl,
    )
    if ('kind' in depOutcome) return depOutcome
    const parsed = parseDeploymentEntries(depOutcome.json)
    if (!parsed) return invalid('deployments-schema-mismatch')
    deploymentMalformed = parsed.malformedCount
    deploymentRoutes = parsed.deployments.map((deployment) => ({
      selectionKey: deployment.id,
      invocationId: deployment.id,
      routeKind: 'deployment-id' as const,
      readiness: deployment.status === 'RUNNING' ? ('ready' as const) : ('not-ready' as const),
      maturity: 'experimental' as const,
      ...(deployment.modelId !== undefined ? { canonicalModelId: deployment.modelId } : {}),
    }))
  }

  const allRoutes = [...routes, ...deploymentRoutes]
  const kind = deploymentMalformed > 0 || catalogParsed.malformedCount > 0 ? 'partial' : 'complete'
  const reasonParts: string[] = []
  if (authorizedIds) reasonParts.push(`authorized:${authorizedIds.length}`)
  if (deploymentRoutes.length > 0) reasonParts.push(`deployments:${deploymentRoutes.length}`)
  if (kind === 'partial') reasonParts.push(`malformed:${deploymentMalformed + catalogParsed.malformedCount}`)
  return {
    kind,
    routes: allRoutes,
    reason: reasonParts.join(',') || 'http-200-complete',
    authTombstoneEligible: false,
    enumerationUnsupported: false,
  }
}

// Re-exported so tests/consumers share one envelope vocabulary.
export { parseModelListEnvelope, routesFromEntries }
