/**
 * Relay-aware reasoning types (design §11-13, §16, §27-29).
 *
 * A relay (New API, Sub2API, or an unknown gateway) receives an OpenAI-style
 * request, translates it internally, and forwards to a real upstream. OpenCode
 * must therefore reason about TWO things separately:
 *
 *   Ingress Surface  - the wire format OpenCode uses to talk to the relay.
 *   Hidden Upstream  - which real upstream the relay may route to (evidence
 *                      only; never the sole input to the wire format).
 *
 * Nothing here stores credentials; only structural evidence is kept.
 */

export type RelayKind =
  | 'direct'
  | 'new-api'
  | 'sub2api'
  | 'unknown-relay'

export type RelayDetectionConfidence = 'exact' | 'high' | 'medium' | 'none'

export interface RelayDetection {
  kind: RelayKind
  confidence: RelayDetectionConfidence
  evidence: string[]
  /** True when the relay may route the same model to different upstreams. */
  dynamic: boolean
}

/** The wire surface between OpenCode and the current provider/relay. */
export type ReasoningIngressSurface =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-gemini'
  | 'newapi-openai'
  | 'sub2api-openai'
  | 'sub2api-anthropic'
  | 'unknown'

export interface RawRelayModelMetadata {
  ownedBy?: string
  supportedEndpointTypes?: string[]
  supportsReasoningEffort?: boolean
  reasoningEffort?: string
  reasoningEfforts?: Array<{ value: string }>
  reasoningOptions?: unknown
  relayVersion?: string
}

export interface RelayModelEvidence {
  relayKind: RelayKind
  modelId: string
  metadata: RawRelayModelMetadata
  rawMetadataSource: 'models-endpoint' | 'relay-introspection' | 'none'
}

export type ModelIdentityConfidence =
  | 'exact'
  | 'advertised-standard-id'
  | 'alias'
  | 'ambiguous'
  | 'unknown'

export interface RouteEvidence {
  /** Canonical host ids the model may route to. */
  possibleHosts: string[]
  /** Preferred host from route evidence (e.g. New API owned_by). */
  preferredHost?: string
  source: 'provider-native' | 'new-api-owned-by' | 'relay-profile' | 'models-dev' | 'none'
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'none'
  /** True when the preferred host can change (channel priority/weight/retry). */
  dynamic: boolean
}

export interface RelayResolutionInput {
  providerId?: string
  npm?: string
  baseURL?: string
  modelId: string
  rawModel?: Record<string, unknown>
  relayConfig?: 'auto' | 'new-api' | 'sub2api' | 'none' | undefined
}
