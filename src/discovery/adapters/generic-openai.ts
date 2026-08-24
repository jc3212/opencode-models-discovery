/**
 * Generic OpenAI-compatible relay inventory adapter (v3 plan §7.2, WP2).
 *
 * The highest-priority user scenario: an authenticated `GET /v1/models`
 * against the SAME key that serves inference. Default visibility is
 * `credential-observed`; authoritative shrink/empty (strict) is only
 * enabled when the user explicitly declares a `credential-effective`
 * contract for the gateway (§13.1/§13.4).
 *
 * Failure semantics follow §8.4 via `classifyInventoryHttpStatus` with
 * `inference-surface` auth semantics: this endpoint is served by the same
 * gateway surface that routes inference, so a confirmed 401 rejects the
 * credential itself and may produce a tombstone.
 */

import type { DiscoveredRoute, ProviderInventoryContract } from '../types'
import { executeDiscoveryRequest, DiscoveryHttpError, type FetchLike } from '../http-client'
import {
  classifyInventoryHttpStatus,
  classifyTransportError,
  detectBusinessErrorBody,
  parseModelListEnvelope,
  routesFromEntries,
  type InventoryFetchResult,
} from './shared'

/** Shared adapter flow: transport errors → transient, non-200 → §8.4 table, then JSON + schema validation. */
export async function executeAdapterRequest(
  spec: { url: string; headers: Record<string, string>; signal?: AbortSignal },
  endpointAuth: Parameters<typeof classifyInventoryHttpStatus>[1],
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult | { status: number; headers: Record<string, string>; json: unknown }> {
  let response
  try {
    response = await executeDiscoveryRequest(spec, fetchImpl)
  } catch (error) {
    if (error instanceof DiscoveryHttpError) return { ...classifyTransportError(error), routes: [] }
    throw error
  }
  if (response.status !== 200) {
    return { ...classifyInventoryHttpStatus(response.status, endpointAuth), routes: [] }
  }
  let json: unknown
  try {
    json = JSON.parse(response.bodyText)
  } catch {
    return { kind: 'invalid', routes: [], reason: 'malformed-json', authTombstoneEligible: false, enumerationUnsupported: false }
  }
  return { status: response.status, headers: response.headers, json }
}

export async function fetchGenericOpenAIInventory(
  config: GenericOpenAIAdapterConfig,
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  const headers: Record<string, string> = { accept: 'application/json', ...config.headers }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const outcome = await executeAdapterRequest(
    { url: config.url, headers, signal: config.signal },
    'inference-surface',
    fetchImpl,
  )
  if ('kind' in outcome) return outcome

  const businessError = detectBusinessErrorBody(outcome.json)
  if (businessError) {
    return {
      kind: 'invalid',
      routes: [],
      reason: `business-error-body${businessError.code ? `:${businessError.code}` : ''}`,
      authTombstoneEligible: false,
      enumerationUnsupported: false,
    }
  }

  const parsed = parseModelListEnvelope(outcome.json)
  if (!parsed) {
    return { kind: 'invalid', routes: [], reason: 'schema-mismatch', authTombstoneEligible: false, enumerationUnsupported: false }
  }
  if (parsed.malformedCount > 0) {
    return { kind: 'partial', routes: [], reason: `malformed-entries:${parsed.malformedCount}`, authTombstoneEligible: false, enumerationUnsupported: false }
  }

  const routes: DiscoveredRoute[] = routesFromEntries(parsed.entries)
  return { kind: 'complete', routes, reason: 'http-200-complete', authTombstoneEligible: false, enumerationUnsupported: false }
}

export const GENERIC_OPENAI_ADAPTER_ID = 'generic-openai' as const
export const GENERIC_OPENAI_ADAPTER_VERSION = 1

export interface GenericOpenAIAdapterConfig {
  /** Absolute request URL, e.g. `https://relay.example.com/v1/models`. */
  url: string
  apiKey?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * User-declared contract for the gateway's `/models` list (§13.4).
   * `credential-effective` upgrades strictEligible; everything else stays
   * observed.
   */
  contract?: 'observed' | 'provider-available' | 'credential-effective'
}

export function genericOpenAIInventoryContract(config?: { contract?: GenericOpenAIAdapterConfig['contract'] }): ProviderInventoryContract {
  return {
    adapterId: GENERIC_OPENAI_ADAPTER_ID,
    adapterVersion: GENERIC_OPENAI_ADAPTER_VERSION,
    recognition: { providerIds: [], exactOrigins: [] },
    authKind: 'inference-key',
    visibilitySemantics: 'credential-observed',
    visibilityScope: 'credential',
    endpoint: '/v1/models',
    pagination: 'none',
    completeEmptyIsAuthoritative: config?.contract === 'credential-effective',
    // Authenticated request alone NEVER implies strict eligibility (§5.1);
    // only an explicit user-declared effective contract upgrades it.
    strictEligible: config?.contract === 'credential-effective',
  }
}
