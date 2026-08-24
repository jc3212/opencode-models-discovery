/**
 * Volcengine Ark adapter (v3 plan §7.4, WP3).
 *
 * Data-plane and control-plane authentication are SEPARATE: `ARK_API_KEY`
 * only authorizes inference and can never call `ListEndpoints`-style
 * management APIs (those require VolcengineSign with AK/SK). Until an
 * official interface proves a binding between the target ARK key's identity
 * and control-plane scope, this adapter performs ZERO enumeration:
 * callable knowledge comes from explicit endpoint/model IDs or host-native
 * integration, optionally intersected later via user caps.
 *
 * The `account-endpoints` strategy (explicit minimal-read-only AK/SK) is
 * intentionally NOT implemented here — it stays experimental-off until its
 * dual-credential contract and non-empty cap validation exist upstream.
 */

import type { FetchLike } from '../http-client'
import type { ProviderInventoryContract } from '../types'
import type { InventoryFetchResult } from './shared'

export const VOLCENGINE_ARK_ADAPTER_ID = 'volcengine-ark' as const
export const VOLCENGINE_ARK_ADAPTER_VERSION = 1

/** Contract for the frozen ARK_API_KEY-only mode. */
export function volcengineArkContract(providerId = 'ark'): ProviderInventoryContract {
  return {
    adapterId: VOLCENGINE_ARK_ADAPTER_ID,
    adapterVersion: VOLCENGINE_ARK_ADAPTER_VERSION,
    recognition: { providerIds: [providerId], exactOrigins: ['https://ark.cn-beijing.volces.com'] },
    authKind: 'inference-key',
    visibilitySemantics: 'non-enumerable',
    visibilityScope: 'credential',
    endpoint: '',
    pagination: 'none',
    completeEmptyIsAuthoritative: false,
    strictEligible: false,
  }
}

/**
 * Zero-network guard: an inference-only ARK key has NO discoverable
 * inventory. Any attempt to reach the control plane from here would be a
 * contract violation, so the fetcher refuses unconditionally.
 */
export async function fetchVolcengineArkInventory(
  config: { strategy?: 'explicit' | 'account-endpoints' },
  _fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  if (config.strategy === 'account-endpoints') {
    return {
      kind: 'invalid',
      routes: [],
      reason: 'account-endpoints-experimental-off',
      authTombstoneEligible: false,
      enumerationUnsupported: true,
    }
  }
  return {
    kind: 'invalid',
    routes: [],
    reason: 'inference-key-non-enumerable',
    authTombstoneEligible: false,
    enumerationUnsupported: true,
  }
}
