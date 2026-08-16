import type {
  RelayDetection,
  RelayModelEvidence,
  RouteEvidence,
  ReasoningIngressSurface,
} from './types'
import { detectRelayKind, isRelayDetectionUsable } from './detection'
import { resolveRouteEvidence, resolveIngressSurface } from './route-evidence'
import { resolveCapabilityConsensus } from '../consensus'
import type { ReasoningOption } from '../types'
import type { ModelsDevModel } from '../../utils/models-dev-fetcher'
import { lookupModelsDevData } from '../../utils/models-dev-fetcher'

/**
 * Relay-aware reasoning resolution (design §80).
 *
 * This is the SHADOW resolver: it computes what relay-aware resolution WOULD
 * produce, without injecting variants into runtime config. It is used by the
 * audit tool to compare current vs relay-aware coverage on the real 82-model
 * set before any runtime behavior changes.
 */

export interface RelayAwareResult {
  modelId: string
  relay: RelayDetection
  ingress: ReasoningIngressSurface
  route: RouteEvidence
  identityConfidence: 'exact' | 'advertised-standard-id' | 'alias' | 'ambiguous' | 'unknown'
  candidateHosts: string[]
  /** Canonical candidates (models.dev ids) used for consensus. */
  candidateModels: ModelsDevModel[]
  consensusOptions: ReasoningOption[]
  consensusSource: 'provider-native' | 'models-dev-consensus' | 'direct' | 'none'
  safeToCompile: boolean
  reason: string
}

function extractRelayEvidence(rawModel: Record<string, unknown> | undefined): RelayModelEvidence | undefined {
  if (!rawModel || typeof rawModel !== 'object') return undefined
  const id = typeof rawModel.id === 'string' ? rawModel.id : ''
  return {
    relayKind: 'unknown-relay',
    modelId: id,
    metadata: {
      ownedBy: typeof rawModel.owned_by === 'string' ? rawModel.owned_by : undefined,
      supportedEndpointTypes: Array.isArray(rawModel.supported_endpoint_types)
        ? (rawModel.supported_endpoint_types as unknown[]).filter((v): v is string => typeof v === 'string')
        : undefined,
      supportsReasoningEffort: typeof rawModel.supportsReasoningEffort === 'boolean' ? rawModel.supportsReasoningEffort : undefined,
      reasoningEffort: typeof rawModel.reasoningEffort === 'string' ? rawModel.reasoningEffort : undefined,
      reasoningEfforts: Array.isArray(rawModel.reasoningEfforts) ? (rawModel.reasoningEfforts as Array<{ value: string }>) : undefined,
      reasoningOptions: rawModel.reasoning_options,
    },
    rawMetadataSource: 'models-endpoint',
  }
}

/**
 * Finds the candidate models.dev entries for a model id, ranked so that the
 * relay's preferred host is first. Returns all candidates (not just the
 * preferred one) so consensus can be computed safely.
 */
function findCandidateModels(
  modelId: string,
  index: Map<string, ModelsDevModel>,
  preferredHost: string | undefined,
): ModelsDevModel[] {
  const cleanId = modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
  const parts = cleanId.split('/')
  const modelPart = (parts.length > 1 ? parts.slice(1).join('/') : parts[0]!).toLowerCase()

  const candidates: ModelsDevModel[] = []
  const seen = new Set<string>()

  // 1. Preferred host (from relay owned_by), e.g. openrouter/gpt-5.4.
  if (preferredHost) {
    const id = preferredHost + '/' + (parts.length > 1 ? modelPart : parts[0])
    const hit = index.get(id)
    if (hit) {
      candidates.push(hit)
      seen.add(hit.id)
    }
  }

  // 2. Exact / namespace match.
  const exact = index.get(cleanId) ?? index.get(cleanId.toLowerCase())
  if (exact && !seen.has(exact.id)) {
    candidates.push(exact)
    seen.add(exact.id)
  }

  // 3. All hosts that share the model part.
  for (const [key, model] of index.entries()) {
    const keyParts = key.split('/')
    if (keyParts.slice(1).join('/').toLowerCase() === modelPart && !seen.has(key)) {
      candidates.push(model)
      seen.add(key)
    }
  }

  return candidates
}

export interface RelayAwareInput {
  providerId?: string
  npm?: string
  baseURL?: string
  modelId: string
  rawModel?: Record<string, unknown>
  modelsDevIndex: Map<string, ModelsDevModel>
  aliases?: Record<string, string>
  relayConfig?: 'auto' | 'new-api' | 'sub2api' | 'none' | undefined
}

export function resolveRelayAware(input: RelayAwareInput): RelayAwareResult {
  const { modelId, modelsDevIndex, rawModel } = input

  const relay = detectRelayKind({
    providerId: input.providerId,
    npm: input.npm,
    baseURL: input.baseURL,
    modelId,
    rawModel,
    relayConfig: input.relayConfig,
  })
  const ingress = resolveIngressSurface(relay, { npm: input.npm, baseURL: input.baseURL })
  const route = resolveRouteEvidence(relay, { modelId, rawModel })

  // Alias is the strongest identity evidence (design §28).
  const aliasTarget = input.aliases?.[modelId]
  if (aliasTarget && typeof aliasTarget === 'string') {
    const target = modelsDevIndex.get(aliasTarget) ?? modelsDevIndex.get(aliasTarget.toLowerCase())
    const options = target?.reasoning_options ?? []
    return {
      modelId,
      relay,
      ingress,
      route,
      identityConfidence: 'alias',
      candidateHosts: [aliasTarget],
      candidateModels: target ? [target] : [],
      consensusOptions: options,
      consensusSource: options.length > 0 ? 'models-dev-consensus' : 'none',
      safeToCompile: isRelayDetectionUsable(relay) && options.length > 0,
      reason: 'user-alias',
    }
  }

  // Provider-native metadata (Sub2API Grok, reasoning_options, ...) is exact.
  const evidence = extractRelayEvidence(rawModel)
  if (evidence) {
    const nativeOptions = normalizeNativeOptions(evidence.metadata)
    if (nativeOptions.length > 0) {
      return {
        modelId,
        relay,
        ingress,
        route,
        identityConfidence: 'advertised-standard-id',
        candidateHosts: route.possibleHosts,
        candidateModels: [],
        consensusOptions: nativeOptions,
        consensusSource: 'provider-native',
        safeToCompile: isRelayDetectionUsable(relay) || relay.kind === 'direct',
        reason: 'provider-native-metadata',
      }
    }
  }

  // models.dev candidate consensus.
  const candidateModels = findCandidateModels(modelId, modelsDevIndex, route.preferredHost)
  const candidates = candidateModels.map((m) => ({
    metadata: { reasoning: m.reasoning === true, options: m.reasoning_options ?? [] },
  }))
  const consensus = resolveCapabilityConsensus(candidates)

  const isStandardId = /^[a-z0-9][a-z0-9._-]*([\/][a-z0-9][a-z0-9._-]*)?$/i.test(modelId) &&
    !/^(vip-|custom-|my-|coding-|claude-coding|model-)/.test(modelId)

  return {
    modelId,
    relay,
    ingress,
    route,
    identityConfidence: consensus.allCandidatesKnown ? 'advertised-standard-id' : 'unknown',
    candidateHosts: candidateModels.map((m) => m.id),
    candidateModels,
    consensusOptions: consensus.options,
    consensusSource: consensus.options.length > 0 ? 'models-dev-consensus' : 'none',
    safeToCompile: isRelayDetectionUsable(relay) && consensus.allCandidatesKnown && consensus.options.length > 0,
    reason: consensus.options.length > 0
      ? 'models-dev-consensus'
      : consensus.allCandidatesKnown
        ? 'consensus-empty'
        : 'missing-candidate-metadata',
  }
}

function normalizeNativeOptions(metadata: {
  reasoningOptions?: unknown
  supportsReasoningEffort?: boolean
  reasoningEffort?: string
  reasoningEfforts?: Array<{ value: string }>
}): ReasoningOption[] {
  const options: ReasoningOption[] = []

  if (Array.isArray(metadata.reasoningOptions)) {
    const values: string[] = []
    for (const entry of metadata.reasoningOptions as unknown[]) {
      if (entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'effort') {
        const v = (entry as { values?: unknown }).values
        if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') values.push(x)
      }
    }
    if (values.length > 0) options.push({ type: 'effort', values })
  }

  if (metadata.supportsReasoningEffort === true) {
    const values: string[] = []
    if (Array.isArray(metadata.reasoningEfforts)) {
      for (const e of metadata.reasoningEfforts) if (e && typeof e.value === 'string') values.push(e.value)
    }
    if (!values.length && typeof metadata.reasoningEffort === 'string') values.push(metadata.reasoningEffort)
    if (values.length > 0) options.push({ type: 'effort', values })
  }

  return options
}

export const relayShadowTestUtils = {
  extractRelayEvidence,
  findCandidateModels,
}
