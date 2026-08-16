import type {
  RelayDetection,
  ReasoningIngressSurface,
  RouteEvidence,
} from './types'

/**
 * Route evidence resolution (design §29, §16).
 *
 * New API `owned_by` is route EVIDENCE from a preferred-channel algorithm
 * (priority/weight/enabled/user-group), not a request-level guarantee. It can
 * change, so it is always marked dynamic and only used to rank candidates.
 */

const KNOWN_HOST_SLUGS: Record<string, string> = {
  openai: 'openai',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  deepseek: 'deepseek',
  alibaba: 'alibaba',
  dashscope: 'dashscope',
  groq: 'groq',
  xai: 'xai',
  grok: 'xai',
  mistral: 'mistral',
}

function normalizeHostName(value: string | undefined): string | undefined {
  if (!value) return undefined
  const lower = value.trim().toLowerCase()
  return KNOWN_HOST_SLUGS[lower] ?? lower
}

/**
 * Builds route evidence for a model. `possibleHosts` is the set of hosts the
 * relay could plausibly route to; `preferredHost` is the ranked leader when
 * the relay exposes one (New API owned_by).
 */
export function resolveRouteEvidence(
  detection: RelayDetection,
  input: { modelId: string; rawModel?: Record<string, unknown> },
): RouteEvidence {
  const raw = input.rawModel ?? {}
  const ownedBy = typeof raw.owned_by === 'string' && raw.owned_by.length > 0 ? raw.owned_by : undefined
  const preferredHost = normalizeHostName(ownedBy)

  // Possible hosts: prefer the relay's own hint, fall back to the model id's
  // namespace. This is evidence for consensus, never a guarantee.
  const possibleHosts: string[] = []
  if (preferredHost) possibleHosts.push(preferredHost)
  const idParts = input.modelId.split('/')
  if (idParts.length > 1) {
    const ns = normalizeHostName(idParts[0])
    if (ns && !possibleHosts.includes(ns)) possibleHosts.push(ns)
  }

  if (detection.kind === 'new-api' || detection.kind === 'sub2api') {
    return {
      possibleHosts,
      ...(preferredHost ? { preferredHost } : {}),
      source: preferredHost ? 'new-api-owned-by' : 'provider-native',
      confidence: preferredHost ? 'high' : 'low',
      dynamic: true,
    }
  }

  if (possibleHosts.length > 0) {
    return {
      possibleHosts,
      ...(preferredHost ? { preferredHost } : {}),
      source: 'provider-native',
      confidence: 'low',
      dynamic: false,
    }
  }

  return {
    possibleHosts: [],
    source: 'none',
    confidence: 'none',
    dynamic: false,
  }
}

/**
 * Resolves the ingress surface: how OpenCode talks to this provider/relay.
 * The npm package is the primary signal; relay kinds refine it.
 */
export function resolveIngressSurface(
  detection: RelayDetection,
  input: { npm?: string; baseURL?: string },
): ReasoningIngressSurface {
  const npm = input.npm ?? ''

  if (detection.kind === 'new-api' && isRelayUsable(detection)) {
    return 'newapi-openai'
  }
  if (detection.kind === 'sub2api' && isRelayUsable(detection)) {
    return 'sub2api-openai'
  }

  if (npm === '@ai-sdk/openai') return 'openai-responses'
  if (npm === '@ai-sdk/anthropic') return 'anthropic-messages'
  if (npm === '@ai-sdk/google' || npm === '@ai-sdk/google-vertex') return 'google-gemini'
  if (npm === '@openrouter/ai-sdk-provider') return 'openai-chat'
  if (npm === '@ai-sdk/openai-compatible') return 'openai-chat'
  return 'unknown'
}

function isRelayUsable(detection: RelayDetection): boolean {
  return detection.confidence === 'exact' || detection.confidence === 'high'
}