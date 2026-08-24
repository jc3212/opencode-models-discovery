/**
 * DeepSeek official-origin inventory adapter (WP2/WP3 provider table).
 *
 * DeepSeek serves one OpenAI-compatible surface on `https://api.deepseek.com`
 * with a single inference key; `GET /models` shares that key, so a confirmed
 * 401 there rejects the credential identity itself (inference-surface
 * semantics). Recognition is exact-origin only: a mirror that copies the
 * path shape must go through the generic adapter instead. There is no
 * documented current-identity filtering contract, so this adapter is never
 * strictEligible on its own (§5.1).
 */

import type { FetchLike } from '../http-client'
import type { ProviderInventoryContract } from '../types'
import type { InventoryFetchResult } from './shared'
import {
  fetchGenericOpenAIInventory,
  GENERIC_OPENAI_ADAPTER_VERSION,
} from './generic-openai'

export const DEEPSEEK_ADAPTER_ID = 'deepseek-official' as const
export const DEEPSEEK_OFFICIAL_ORIGINS: readonly string[] = ['https://api.deepseek.com']

const OFFICIAL_ORIGINS = new Set(DEEPSEEK_OFFICIAL_ORIGINS)

/** True only for an HTTPS origin exactly equal to an official DeepSeek origin. */
export function isDeepSeekOfficialOrigin(baseUrl: unknown): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) return false
  try {
    const url = new URL(baseUrl.trim())
    return url.protocol === 'https:' && OFFICIAL_ORIGINS.has(url.origin)
  } catch {
    return false
  }
}

export interface DeepSeekAdapterConfig {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  signal?: AbortSignal
}

function officialEndpoint(baseUrl: string): string | undefined {
  try {
    return `${new URL(baseUrl.trim()).origin}/models`
  } catch {
    return undefined
  }
}

/**
 * Fetches the official DeepSeek model list. Non-official origins and missing
 * credentials fail closed with ZERO network traffic.
 */
export async function fetchDeepSeekInventory(
  config: DeepSeekAdapterConfig,
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  if (!isDeepSeekOfficialOrigin(config.baseUrl)) {
    return {
      kind: 'invalid',
      routes: [],
      reason: 'non-official-origin',
      authTombstoneEligible: false,
      enumerationUnsupported: false,
    }
  }
  if (!config.apiKey || config.apiKey.length === 0) {
    return {
      kind: 'invalid',
      routes: [],
      reason: 'missing-credentials',
      authTombstoneEligible: false,
      enumerationUnsupported: false,
    }
  }
  const url = officialEndpoint(config.baseUrl)
  if (!url) {
    return {
      kind: 'invalid',
      routes: [],
      reason: 'invalid-base-url',
      authTombstoneEligible: false,
      enumerationUnsupported: false,
    }
  }
  return fetchGenericOpenAIInventory(
    {
      url,
      apiKey: config.apiKey,
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      ...(config.signal !== undefined ? { signal: config.signal } : {}),
    },
    fetchImpl,
  )
}

export function deepSeekInventoryContract(): ProviderInventoryContract {
  return {
    adapterId: DEEPSEEK_ADAPTER_ID,
    // The wire protocol is the shared generic-openai machinery; bump both
    // versions together when envelope handling changes.
    adapterVersion: GENERIC_OPENAI_ADAPTER_VERSION,
    recognition: {
      providerIds: ['deepseek'],
      exactOrigins: [...DEEPSEEK_OFFICIAL_ORIGINS],
    },
    authKind: 'inference-key',
    visibilitySemantics: 'credential-observed',
    visibilityScope: 'credential',
    endpoint: '/models',
    pagination: 'none',
    completeEmptyIsAuthoritative: false,
    strictEligible: false,
  }
}
