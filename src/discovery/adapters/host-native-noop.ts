/**
 * Host-native no-op adapter (v3 plan §7.5, WP3).
 *
 * For providers whose catalog is fully owned by the host (OpenCode Zen/Go,
 * `strategy: 'no-op'`, host-native integrations). This adapter MUST never be
 * executed on a live path: the provider plan classifies such providers as
 * `no-contribution` before any adapter would run. The fetch function exists
 * only to fail loudly if wiring ever regresses — it performs ZERO network
 * traffic and never produces routes.
 */

import type { FetchLike } from '../http-client'
import type { ProviderInventoryContract } from '../types'
import type { InventoryFetchResult } from './shared'

export const HOST_NATIVE_ADAPTER_ID = 'host-native' as const
export const HOST_NATIVE_ADAPTER_VERSION = 1

/** Contract declaring "the host owns this catalog entirely". */
export function hostNativeNoopContract(providerId: string): ProviderInventoryContract {
  return {
    adapterId: HOST_NATIVE_ADAPTER_ID,
    adapterVersion: HOST_NATIVE_ADAPTER_VERSION,
    recognition: { providerIds: [providerId], exactOrigins: [] },
    authKind: 'none',
    visibilitySemantics: 'non-enumerable',
    visibilityScope: 'public',
    endpoint: '',
    pagination: 'none',
    completeEmptyIsAuthoritative: false,
    strictEligible: false,
  }
}

/**
 * Guard stub: proves by construction that a host-native provider never
 * reaches the network. Callers must route these providers through the
 * `contribution: 'none'` projection path instead (§7.5 deep-equality rule).
 */
export async function fetchHostNativeNoopInventory(
  _config: unknown,
  fetchImpl: FetchLike,
): Promise<InventoryFetchResult> {
  void fetchImpl
  return {
    kind: 'invalid',
    routes: [],
    reason: 'delegated-to-host',
    authTombstoneEligible: false,
    enumerationUnsupported: true,
  }
}
