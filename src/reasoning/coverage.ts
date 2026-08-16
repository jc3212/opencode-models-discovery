import type { ResolvedReasoning } from './types'

/**
 * Reasoning coverage report (design §10-12).
 *
 * Classifies every discovered model into a status that explains WHY it has or
 * does not have automatic reasoning variants. This is a pure data layer: no
 * network, no file I/O, no model calls.
 */

export type ReasoningCoverageStatus =
  | 'VERIFIED'
  | 'RESOLVED'
  | 'CAPABILITY_UNKNOWN'
  | 'TRANSPORT_UNKNOWN'
  | 'NOT_REASONING'

export interface ReasoningCoverageEntry {
  providerId: string
  modelId: string
  reasoningKnown: boolean
  capabilityStatus: 'resolved' | 'unresolved' | 'unsupported'
  transportStatus: 'verified' | 'resolved' | 'unknown'
  status: ReasoningCoverageStatus
  variants: string[]
  reason?: string
}

export interface ReasoningCoverageSummary {
  providerId: string
  totalModels: number
  reasoningModels: number
  verifiedModels: number
  resolvedModels: number
  capabilityUnknown: number
  transportUnknown: number
  notReasoning: number
  variantEnabledModels: number
}

export interface ReasoningCoverageReport {
  providerId: string
  entries: ReasoningCoverageEntry[]
  summary: ReasoningCoverageSummary
}

/** Which transports have wire-level evidence (design §11 VERIFIED). */
const VERIFIED_TRANSPORTS = new Set(['openai-compatible-effort', 'dashscope-chat', 'openrouter'])

/**
 * Classifies a single resolved reasoning result. The `wireVerified` flag
 * marks transports proven against a real SDK + captured HTTP body; everything
 * else that resolves is RESOLVED.
 */
export function classifyReasoningEntry(
  providerId: string,
  resolution: ResolvedReasoning,
  options: { wireVerified?: boolean } = {},
): ReasoningCoverageEntry {
  const { model, capability, transport, variants } = resolution
  const variantKeys = Object.keys(variants)

  // Model explicitly confirmed to not reason (metadata says reasoning=false).
  if (capability.reasoning === false && capability.source !== 'none') {
    return {
      providerId,
      modelId: model.discoveredModelId,
      reasoningKnown: false,
      capabilityStatus: 'unsupported',
      transportStatus: 'unknown',
      status: 'NOT_REASONING',
      variants: [],
      reason: 'model-not-reasoning',
    }
  }

  // Capability unknown: model discovered, no reliable reasoning metadata
  // (or metadata unresolved). Distinct from confirmed NOT_REASONING.
  if (!capability.reasoning || (capability.options.length === 0 && capability.confidence === 'none')) {
    return {
      providerId,
      modelId: model.discoveredModelId,
      reasoningKnown: false,
      capabilityStatus: 'unresolved',
      transportStatus: 'unknown',
      status: 'CAPABILITY_UNKNOWN',
      variants: [],
      reason: 'no-reliable-reasoning-metadata',
    }
  }

  // Transport unknown: capability known, but how to send controls is unknown.
  if (transport.transport === 'unknown' || !transport.safeToCompile) {
    return {
      providerId,
      modelId: model.discoveredModelId,
      reasoningKnown: true,
      capabilityStatus: 'resolved',
      transportStatus: 'unknown',
      status: 'TRANSPORT_UNKNOWN',
      variants: [],
      reason: transport.reason,
    }
  }

  // Transport resolved; wire verification decides VERIFIED vs RESOLVED.
  const wireVerified = options.wireVerified === true || VERIFIED_TRANSPORTS.has(transport.transport)
  return {
    providerId,
    modelId: model.discoveredModelId,
    reasoningKnown: true,
    capabilityStatus: 'resolved',
    transportStatus: wireVerified ? 'verified' : 'resolved',
    status: wireVerified ? 'VERIFIED' : 'RESOLVED',
    variants: variantKeys,
  }
}

/**
 * Builds a full coverage report from a list of per-model reasoning
 * resolutions. Pure function.
 */
export function buildReasoningCoverageReport(
  providerId: string,
  resolutions: ResolvedReasoning[],
  options: { wireVerified?: boolean } = {},
): ReasoningCoverageReport {
  const entries = resolutions.map((resolution) => classifyReasoningEntry(providerId, resolution, options))

  const summary: ReasoningCoverageSummary = {
    providerId,
    totalModels: entries.length,
    reasoningModels: entries.filter((e) => e.reasoningKnown).length,
    verifiedModels: entries.filter((e) => e.status === 'VERIFIED').length,
    resolvedModels: entries.filter((e) => e.status === 'RESOLVED').length,
    capabilityUnknown: entries.filter((e) => e.status === 'CAPABILITY_UNKNOWN').length,
    transportUnknown: entries.filter((e) => e.status === 'TRANSPORT_UNKNOWN').length,
    notReasoning: entries.filter((e) => e.status === 'NOT_REASONING').length,
    variantEnabledModels: entries.filter((e) => e.variants.length > 0).length,
  }

  return { providerId, entries, summary }
}
