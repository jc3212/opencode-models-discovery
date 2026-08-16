import type {
  CanonicalModelResolution,
  ReasoningCapability,
  TransportResolution,
} from './types'
import {
  matchKnownProviderProfile,
  normalizeExplicitTransport,
  type HostSignals,
} from './profiles'

/**
 * Resolves which transport semantics a provider actually uses for reasoning
 * controls. This is the ONLY gate that decides whether automatic variants
 * are compiled. When resolution is not confident enough, the result reports
 * `safeToCompile: false` and the model stays usable without variants.
 *
 * Priority (design §21):
 * 1. explicit transport config
 * 2. known provider profile
 * 3. unknown
 */

export interface TransportResolverInput {
  providerId?: string
  npm?: string
  baseURL?: string
  explicitTransport?: string
  canonical?: CanonicalModelResolution
  capability?: ReasoningCapability
}

function collectSignals(input: TransportResolverInput): HostSignals {
  const signals: HostSignals = {}
  if (typeof input.npm === 'string' && input.npm.length > 0) signals.npm = input.npm
  if (typeof input.baseURL === 'string' && input.baseURL.length > 0) signals.baseURL = input.baseURL
  if (typeof input.providerId === 'string' && input.providerId.length > 0) signals.providerId = input.providerId
  return signals
}

function unknownResult(reason: string): TransportResolution {
  return {
    transport: 'unknown',
    confidence: 'none',
    reason,
    safeToCompile: false,
  }
}

export function resolveReasoningTransport(input: TransportResolverInput): TransportResolution {
  const signals = collectSignals(input)

  // 1. Explicit transport wins outright.
  const explicit = normalizeExplicitTransport(input.explicitTransport)
  if (explicit) {
    return {
      transport: explicit,
      confidence: 'exact',
      reason: 'explicit-config',
      safeToCompile: true,
    }
  }

  // 2. Known provider profile.
  const profileMatch = matchKnownProviderProfile(signals)
  if (profileMatch) {
    return {
      transport: profileMatch.transport,
      confidence: profileMatch.confidence,
      reason: 'known-provider-profile',
      safeToCompile: true,
    }
  }

  // 3. The default npm for relays/gateways must never imply a transport on
  // its own. Only a profile or explicit config unlocks openai-compatible
  // reasoning semantics for unknown hosts.
  if (signals.npm === '@ai-sdk/openai-compatible') {
    return unknownResult('openai-compatible-host-api-surface-unresolved')
  }

  return unknownResult('host-api-surface-unresolved')
}

/** Test helper to build an unknown-but-explicitly-named transport. */
export const reasoningTransportTestUtils = {
  normalizeExplicitTransport,
}