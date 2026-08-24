/**
 * OpenRouter official-origin inventory adapter (v3 plan §7.1, WP2).
 *
 * Two mutually exclusive credential domains (§7.1):
 * - The inference key proves its own type via `GET /api/v1/key`; management
 *   /provisioning keys must never be used for inventory here.
 * - `GET /api/v1/models/user` is an ENUMERATION-ONLY surface. Its auth
 *   failures say nothing about inference validity, so they are classified
 *   as enumeration-unsupported: explicit items survive, zero tombstone,
 *   and a global `/api/v1/models` fallback is forbidden.
 *
 * Strict (`credential-effective`) eligibility stays FALSE until the live
 * Gate-0 fixtures prove the user-filtered endpoint narrows by key
 * (plan §17 stop conditions).
 */

import type { DiscoveredRoute } from '../types'
import { DiscoveryHttpError, type FetchLike } from '../http-client'
import { executeAdapterRequest } from './generic-openai'
import {
  classifyInventoryHttpStatus,
  detectBusinessErrorBody,
  parseModelListEnvelope,
  routesFromEntries,
  type InventoryFetchResult,
} from './shared'

export const OPENROUTER_ADAPTER_ID = 'openrouter' as const
export const OPENROUTER_ADAPTER_VERSION = 1

/** Official OpenRouter API origins; same-name custom relays stay generic. */
const OFFICIAL_ORIGINS = new Set(['https://openrouter.ai', 'https://openrouter.ai/api'])

const KEY_ENDPOINT = '/api/v1/key'
const USER_MODELS_ENDPOINT = '/api/v1/models/user'
const PAGE_LIMIT = 100
const MAX_PAGES = 50

export function isOpenRouterOfficialOrigin(originOrUrl: string): boolean {
  try {
    const parsed = new URL(originOrUrl)
    return OFFICIAL_ORIGINS.has(`${parsed.protocol}//${parsed.host}`)
  } catch {
    return false
  }
}

export interface OpenRouterAdapterConfig {
  /** Official origin base URL, e.g. `https://openrouter.ai`. */
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

interface KeyCapabilityResult {
  authFailure: boolean
}

/**
 * Proves the credential answers on its own key endpoint. A management /
 * provisioning key would be rejected here by design and must never drive
 * the user-models inventory (§7.1); a rejection is treated as an identity
 * failure of the presented credential.
 */
async function probeKeyCapability(
  baseUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchImpl: FetchLike,
): Promise<KeyCapabilityResult> {
  try {
    const outcome = await executeAdapterRequest(
      { url: `${baseUrl}${KEY_ENDPOINT}`, headers: { ...headers }, signal },
      'inference-surface',
      fetchImpl,
    )
    if ('kind' in outcome) return { authFailure: outcome.kind === 'auth-failure' }
    // Management keys are rejected by design; anything that answers here
    // with a usable payload counts as an inference-capable key.
    return { authFailure: false }
  } catch (error) {
    if (error instanceof DiscoveryHttpError && error.code === 'ABORTED') throw error
    return { authFailure: false }
  }
}

/**
 * Fetches the user-filtered model list with full offset pagination.
 * Pagination truncation/loops yield `partial` — never complete (§8.4).
 */
export async function fetchOpenRouterUserInventory(
  config: OpenRouterAdapterConfig,
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  if (!isOpenRouterOfficialOrigin(config.baseUrl)) {
    return { kind: 'invalid', routes: [], reason: 'non-official-origin', authTombstoneEligible: false, enumerationUnsupported: false }
  }
  if (!config.apiKey) {
    return { kind: 'invalid', routes: [], reason: 'credential-unresolved', authTombstoneEligible: false, enumerationUnsupported: false }
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  }

  const keyProbe = await probeKeyCapability(config.baseUrl, headers, config.signal, fetchImpl)
  if (keyProbe.authFailure) {
    return { ...classifyInventoryHttpStatus(401, 'inference-surface'), routes: [], reason: 'key-endpoint-auth-failure' }
  }

  const routes: DiscoveredRoute[] = []
  let totalDeclared: number | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${config.baseUrl}${USER_MODELS_ENDPOINT}?offset=${routes.length}&limit=${PAGE_LIMIT}`
    const outcome = await executeAdapterRequest(
      { url, headers: { ...headers }, signal: config.signal },
      'enumeration-only',
      fetchImpl,
    )
    if ('kind' in outcome) return outcome

    const businessError = detectBusinessErrorBody(outcome.json)
    if (businessError) {
      return { kind: 'invalid', routes: [], reason: `business-error-body${businessError.code ? `:${businessError.code}` : ''}`, authTombstoneEligible: false, enumerationUnsupported: false }
    }

    const parsed = parseModelListEnvelope(outcome.json)
    if (!parsed) return { kind: 'invalid', routes: [], reason: 'schema-mismatch', authTombstoneEligible: false, enumerationUnsupported: false }
    if (parsed.malformedCount > 0) {
      return { kind: 'partial', routes: [], reason: `malformed-entries:${parsed.malformedCount}`, authTombstoneEligible: false, enumerationUnsupported: false }
    }

    if (typeof parsed.totalCount === 'number') totalDeclared = parsed.totalCount

    const seenBefore = new Set(routes.map((route) => route.selectionKey))
    for (const route of routesFromEntries(parsed.entries)) {
      if (!seenBefore.has(route.selectionKey)) {
        seenBefore.add(route.selectionKey)
        routes.push(route)
      }
    }

    const exhaustedByShortPage = parsed.entries.length < PAGE_LIMIT
    const exhaustedByTotal = typeof totalDeclared === 'number' && routes.length >= totalDeclared
    if (exhaustedByShortPage || exhaustedByTotal) break
    if (parsed.entries.length === 0) break
  }

  if (typeof totalDeclared === 'number' && routes.length < totalDeclared) {
    return { kind: 'partial', routes: [], reason: `pagination-truncated:${routes.length}/${totalDeclared}`, authTombstoneEligible: false, enumerationUnsupported: false }
  }

  return { kind: 'complete', routes, reason: 'http-200-complete', authTombstoneEligible: false, enumerationUnsupported: false }
}
