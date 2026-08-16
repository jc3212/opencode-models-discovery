import type { ProviderDiscoveryConfig } from '../types/plugin-config'
import type {
  ReasoningCapability,
  ResolvedReasoning,
  TransportResolution,
} from './types'
import { resolveCanonicalModel } from './canonical-model'
import { resolveReasoningCapability } from './resolver'
import { resolveReasoningTransport } from './transport'
import { compileReasoningVariants } from './compiler'
import { summarizeReasoningResolution } from './diagnostics'
import type { ModelsDevModel } from '../utils/models-dev-fetcher'
import type { ReasoningMetadata } from '../utils/model-info/types'

/**
 * Orchestrates the full reasoning enrichment pipeline for one discovered
 * model. It is deliberately fail-open: any enrichment failure or low
 * confidence only skips automatic variants; the model remains usable.
 *
 * Pipeline: canonical -> capability -> transport -> compile -> merge.
 * The result is written as `modelConfig.variants` (OpenCode model config),
 * which OpenCode applies as provider options on the wire.
 */

export interface ReasoningEnricherInput {
  modelConfig: Record<string, unknown>
  modelId: string
  providerConfig: Record<string, unknown>
  discoveryConfig?: ProviderDiscoveryConfig
  modelsDevIndex?: Map<string, ModelsDevModel>
  providerMetadata?: unknown
  outputLimit?: number
  log?: (message: string, extra?: Record<string, unknown>) => void
}

export interface ReasoningEnricherResult {
  applied: boolean
  resolution?: ResolvedReasoning
}

function providerSignals(providerConfig: Record<string, unknown>, providerId: string | undefined): { npm?: string; baseURL?: string; providerId?: string } {
  const signals: { npm?: string; baseURL?: string; providerId?: string } = {}
  if (typeof providerConfig.npm === 'string') signals.npm = providerConfig.npm
  const baseURL = (providerConfig.options as Record<string, unknown> | undefined)?.baseURL
  if (typeof baseURL === 'string') signals.baseURL = baseURL
  if (providerId) signals.providerId = providerId
  return signals
}

export function resolveReasoningForModel(input: ReasoningEnricherInput): ResolvedReasoning | undefined {
  const { modelId, providerConfig, discoveryConfig } = input
  const reasoningConfig = discoveryConfig?.reasoning
  const aliases = reasoningConfig?.aliases

  const canonical = resolveCanonicalModel({
    modelId,
    aliases,
    modelsDevIndex: input.modelsDevIndex ?? new Map(),
  })

  const metadata: ReasoningMetadata | undefined =
    input.providerMetadata && typeof input.providerMetadata === 'object'
      ? normalizeProviderMetadata(input.providerMetadata)
      : undefined

  let capability: ReasoningCapability
  if (metadata) {
    capability = {
      reasoning: metadata.reasoning,
      options: metadata.options,
      source: metadata.source,
      confidence: metadata.options.length > 0 ? 'exact' : 'none',
      canonicalModelId: canonical.canonicalModelId,
      metadataHostId: metadata.hostId,
    }
  } else {
    const modelsDevModel = input.modelsDevIndex ? input.modelsDevIndex.get(canonical.canonicalModelId ?? modelId) : undefined
    capability = resolveReasoningCapability({ canonical, modelsDevModel })
  }

  const providerId = typeof input.providerConfig.providerId === 'string' ? input.providerConfig.providerId : undefined
  const signals = providerSignals(providerConfig, providerId)

  const transport: TransportResolution = resolveReasoningTransport({
    ...signals,
    explicitTransport: reasoningConfig?.transport,
    canonical,
    capability,
  })

  if (!transport.safeToCompile || !capability.reasoning || capability.options.length === 0) {
    return {
      model: canonical,
      capability,
      transport,
      variants: {},
      warnings: [],
      diagnostics: {},
    }
  }

  const compiled = compileReasoningVariants({
    capabilityOptions: capability.options,
    transport: transport.transport,
    outputLimit: input.outputLimit,
  })

  return {
    model: canonical,
    capability,
    transport,
    variants: compiled.variants,
    warnings: compiled.warnings,
    diagnostics: {},
  }
}

export function applyReasoningEnrichment(input: ReasoningEnricherInput): ReasoningEnricherResult {
  // Defensive: the caller normally skips the call when disabled, but the
  // enricher also refuses to apply so a disabled flag always behaves as
  // before (design §83).
  if (input.discoveryConfig?.reasoning?.enabled === false) {
    return { applied: false }
  }

  let resolution: ResolvedReasoning | undefined
  try {
    resolution = resolveReasoningForModel(input)
  } catch (error) {
    if (input.log) {
      input.log('reasoning enrichment failed; skipping automatic variants', {
        model: input.modelId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return { applied: false }
  }

  if (!resolution) {
    return { applied: false }
  }

  const { variants, transport, capability, model } = resolution

  if (Object.keys(variants).length > 0) {
    input.modelConfig.variants = variants
  }

  if (input.log) {
    input.log('[reasoning]', summarizeReasoningResolution(resolution))
  }

  return { applied: true, resolution }
}

function normalizeProviderMetadata(value: unknown): ReasoningMetadata | undefined {
  const raw = value as Record<string, unknown>
  if (!raw || typeof raw !== 'object') {
    return undefined
  }
  if (Array.isArray(raw.reasoning_options)) {
    return {
      reasoning: true,
      options: raw.reasoning_options as ReasoningCapability['options'],
      source: 'provider-native',
    }
  }
  return undefined
}
