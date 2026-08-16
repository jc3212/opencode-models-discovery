import type { RelayDetection, RelayResolutionInput } from './types'

/**
 * Conservative relay detection (design §15-17).
 *
 * A provider is only classified as a specific relay implementation when the
 * evidence is exact/high. Everything else stays `unknown-relay` or `direct`
 * so no relay-specific logic runs without confidence.
 */

const NEW_API_PROVIDER_IDS = /(^|[/._-])new-?api([/._-]|$)/i
const SUB2API_PROVIDER_IDS = /(^|[/._-])sub-?2-?api([/._-]|$)/i
const NEW_API_HEADER = /x-new-api|x-one-api/i
const SUB2API_HEADER = /sub2api/i

export function detectRelayKind(input: RelayResolutionInput): RelayDetection {
  // 1. User explicitly declares the relay.
  if (input.relayConfig === 'new-api') {
    return { kind: 'new-api', confidence: 'exact', evidence: ['user-config'], dynamic: true }
  }
  if (input.relayConfig === 'sub2api') {
    return { kind: 'sub2api', confidence: 'exact', evidence: ['user-config'], dynamic: true }
  }
  if (input.relayConfig === 'none') {
    return { kind: 'direct', confidence: 'exact', evidence: ['user-config-direct'], dynamic: false }
  }

  // 2. Provider id fingerprint.
  const providerId = input.providerId ?? ''
  if (NEW_API_PROVIDER_IDS.test(providerId)) {
    return { kind: 'new-api', confidence: 'high', evidence: ['provider-id-fingerprint'], dynamic: true }
  }
  if (SUB2API_PROVIDER_IDS.test(providerId)) {
    return { kind: 'sub2api', confidence: 'high', evidence: ['provider-id-fingerprint'], dynamic: true }
  }

  // 3. Base URL fingerprint (hostname hints).
  try {
    const host = new URL(input.baseURL ?? '').hostname.toLowerCase()
    if (host.includes('new-api') || host.includes('newapi')) {
      return { kind: 'new-api', confidence: 'medium', evidence: ['baseurl-host'], dynamic: true }
    }
    if (host.includes('sub2api')) {
      return { kind: 'sub2api', confidence: 'medium', evidence: ['baseurl-host'], dynamic: true }
    }
  } catch {
    // Invalid/absent URL -> no signal.
  }

  // 4. /v1/models response fingerprint: New API exposes owned_by +
  // supported_endpoint_types on model objects (source research, design §15).
  // The presence of BOTH on the first model is a strong New API signal.
  if (input.rawModel) {
    const raw = input.rawModel as Record<string, unknown>
    const hasOwnedBy = typeof raw.owned_by === 'string' && raw.owned_by.length > 0
    const hasEndpointTypes = Array.isArray(raw.supported_endpoint_types) && raw.supported_endpoint_types.length > 0
    if (hasOwnedBy && hasEndpointTypes) {
      return { kind: 'new-api', confidence: 'high', evidence: ['models-endpoint-owned-by+endpoint-types'], dynamic: true }
    }
    if (hasEndpointTypes) {
      return { kind: 'new-api', confidence: 'medium', evidence: ['models-endpoint-supported-endpoint-types'], dynamic: true }
    }
  }

  return { kind: 'unknown-relay', confidence: 'none', evidence: ['no-relay-signal'], dynamic: false }
}

/**
 * Whether relay-aware reasoning logic may run for a detection. Only exact or
 * high confidence unlocks relay-specific behavior.
 */
export function isRelayDetectionUsable(detection: RelayDetection): boolean {
  return detection.confidence === 'exact' || detection.confidence === 'high'
}

export const relayDetectionTestUtils = {
  NEW_API_PROVIDER_IDS,
  SUB2API_PROVIDER_IDS,
  NEW_API_HEADER,
  SUB2API_HEADER,
}