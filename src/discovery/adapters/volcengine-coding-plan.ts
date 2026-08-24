/**
 * Volcengine Ark Coding Plan adapter (v3 plan §7.4, WP3).
 *
 * `ListArkCodingPlanModel` documentation was updated 2026-08-20, but its
 * authentication, key-type semantics, pagination and empty-set behavior are
 * not frozen yet (Gate 0 pending). The path stays `experimental off`: this
 * adapter never issues requests and marks results as catalog-plan
 * diagnostics only.
 */

import type { FetchLike } from '../http-client'
import type { ProviderInventoryContract } from '../types'
import type { InventoryFetchResult } from './shared'

export const VOLCENGINE_CODING_PLAN_ADAPTER_ID = 'volcengine-coding-plan' as const
export const VOLCENGINE_CODING_PLAN_ADAPTER_VERSION = 1

export function volcengineCodingPlanContract(providerId = 'volcengine-coding-plan'): ProviderInventoryContract {
  return {
    adapterId: VOLCENGINE_CODING_PLAN_ADAPTER_ID,
    adapterVersion: VOLCENGINE_CODING_PLAN_ADAPTER_VERSION,
    recognition: { providerIds: [providerId], exactOrigins: [] },
    authKind: 'inference-key',
    visibilitySemantics: 'non-enumerable',
    visibilityScope: 'credential',
    endpoint: '',
    pagination: 'none',
    completeEmptyIsAuthoritative: false,
    strictEligible: false,
  }
}

/** Zero-network guard stub until the coding-plan contract is frozen. */
export async function fetchVolcengineCodingPlanInventory(
  _config: unknown,
  _fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  return {
    kind: 'invalid',
    routes: [],
    reason: 'experimental-catalog-plan-off',
    authTombstoneEligible: false,
    enumerationUnsupported: true,
  }
}
