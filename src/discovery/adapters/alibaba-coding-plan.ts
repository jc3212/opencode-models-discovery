/**
 * Alibaba Coding Plan adapter (v3 plan §7.3, WP3).
 *
 * The official FAQ states the Coding Plan model list CANNOT be queried via
 * ordinary discovery APIs; it uses a dedicated `sk-sp-` key family and an
 * independent base URL. This mode is therefore `non-enumerable`: the plugin
 * contributes nothing automatically and relies on host-native catalogs,
 * official subscription listings, or explicit user models. It NEVER issues
 * a standard `/models` scan for this provider (§16.2 zero-scan fixture).
 */

import type { FetchLike } from '../http-client'
import type { ProviderInventoryContract } from '../types'
import type { InventoryFetchResult } from './shared'

export const ALIBABA_CODING_PLAN_ADAPTER_ID = 'alibaba-coding-plan' as const
export const ALIBABA_CODING_PLAN_ADAPTER_VERSION = 1

export function alibabaCodingPlanContract(providerId = 'alibaba-coding-plan'): ProviderInventoryContract {
  return {
    adapterId: ALIBABA_CODING_PLAN_ADAPTER_ID,
    adapterVersion: ALIBABA_CODING_PLAN_ADAPTER_VERSION,
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

/** Zero-network guard stub: Coding Plan has no discoverable inventory. */
export async function fetchAlibabaCodingPlanInventory(
  _config: unknown,
  _fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  return {
    kind: 'invalid',
    routes: [],
    reason: 'non-enumerable-subscription-plan',
    authTombstoneEligible: false,
    enumerationUnsupported: true,
  }
}
