import type { CanonicalModelResolution } from './types'
import type { ModelsDevModel } from '../utils/models-dev-fetcher'

/**
 * Resolves a discovered API model id to its canonical `provider/model`
 * identity for metadata lookup only. It never rewrites the model id that is
 * sent to the provider.
 *
 * Matching is deliberately conservative and deterministic:
 * - user alias
 * - exact canonical id (case-insensitive)
 * - namespace-stripped exact (gateway prefixes)
 * - unique model-id exact
 * - safe revision/date suffix match
 * - none
 *
 * There is NO fuzzy prefix scoring here. A model like `my-gpt` must never
 * be guessed into `openai/gpt-5`.
 */

interface ResolveCanonicalInput {
  modelId: string
  aliases?: Record<string, string>
  modelsDevIndex: Map<string, ModelsDevModel>
}

/** Strip a models.dev-style `:tag` suffix (e.g. `:free`, `:nitro`). */
function stripTag(modelId: string): string {
  return modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
}

/**
 * Pre-built lookup structures for one models.dev index (v3 plan Gate 1
 * "pre-built indexes"): building them per model lookup made canonical
 * resolution O(catalog x models) per provider. The bundle is memoized per
 * index instance via WeakMap, so repeated `resolveCanonicalModel` calls on
 * the same index are O(1) after the first build. Matching semantics are
 * unchanged: first occurrence wins on case-insensitive key collisions, and
 * match ordering follows original index insertion order.
 */
interface CanonicalIndexBundle {
  lowerIndex: Map<string, ModelsDevModel>
  byModelPart: Map<string, ModelsDevModel[]>
  providers: Set<string>
}

const canonicalIndexCache = new WeakMap<Map<string, ModelsDevModel>, CanonicalIndexBundle>()

function getIndexBundle(index: Map<string, ModelsDevModel>): CanonicalIndexBundle {
  const cached = canonicalIndexCache.get(index)
  if (cached) return cached

  const lowerIndex = new Map<string, ModelsDevModel>()
  for (const [key, value] of index.entries()) {
    if (!lowerIndex.has(key.toLowerCase())) {
      lowerIndex.set(key.toLowerCase(), value)
    }
  }

  const byModelPart = new Map<string, ModelsDevModel[]>()
  const providers = new Set<string>()
  for (const [key, value] of lowerIndex.entries()) {
    const modelPart = splitModelId(key).model.toLowerCase()
    const matches = byModelPart.get(modelPart)
    if (matches) {
      matches.push(value)
    } else {
      byModelPart.set(modelPart, [value])
    }
    const provider = splitModelId(key).provider
    if (provider) providers.add(provider)
  }

  const bundle: CanonicalIndexBundle = { lowerIndex, byModelPart, providers }
  canonicalIndexCache.set(index, bundle)
  return bundle
}

function splitModelId(modelId: string): { provider?: string; model: string } {
  const parts = modelId.split('/')
  if (parts.length <= 1) {
    return { model: modelId }
  }
  return { provider: parts[0], model: parts.slice(1).join('/') }
}

/**
 * Collect provider slugs present in the index, plus the vendor segment of
 * the requested id, so namespace-stripped matching is evidence-based.
 */
function collectProviders(bundle: CanonicalIndexBundle, requested: string): Set<string> {
  const providers = new Set(bundle.providers)
  const requestedProvider = splitModelId(requested).provider
  if (requestedProvider) providers.add(requestedProvider)
  return providers
}

/** Exact (case-insensitive) key lookup. */
function lookupExact(lowerIndex: Map<string, ModelsDevModel>, id: string): ModelsDevModel | undefined {
  return lowerIndex.get(id.toLowerCase())
}

/**
 * Find canonical entries whose final model segment matches `modelPart`
 * exactly (case-insensitive). Returns all matches so ambiguity can be judged.
 */
function findUniqueModelPart(bundle: CanonicalIndexBundle, modelPart: string): ModelsDevModel[] {
  return bundle.byModelPart.get(modelPart.toLowerCase()) ?? []
}

/**
 * A date/revision suffix is safe to strip only when it matches a strict
 * `-YYYY-MM-DD` or `-v<number>` pattern, so `my-gpt` is never treated
 * as a revision of `gpt`.
 */
const REVISION_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|v\d+)$/

/** Test-only access to the memoized per-index bundle (Gate 1). */
export function getCanonicalIndexBundleForTest(index: Map<string, ModelsDevModel>): CanonicalIndexBundle {
  return getIndexBundle(index)
}

export function resolveCanonicalModel(input: ResolveCanonicalInput): CanonicalModelResolution {
  const { modelId, aliases } = input
  const index = input.modelsDevIndex
  const bundle = getIndexBundle(index)
  const lowerIndex = bundle.lowerIndex
  const cleanId = stripTag(modelId).trim()

  if (!cleanId) {
    return { discoveredModelId: modelId, source: 'none', confidence: 'none' }
  }

  // 1. User alias wins outright.
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, modelId)) {
    const aliasTarget = aliases[modelId]
    if (typeof aliasTarget === 'string' && aliasTarget.trim().length > 0) {
      const target = aliasTarget.trim()
      const indexed = lookupExact(lowerIndex, target) ?? lookupExact(lowerIndex, target.split('/').slice(-1)[0] ?? target)
      return {
        discoveredModelId: modelId,
        canonicalModelId: indexed?.id ?? target,
        canonicalProviderId: indexed ? splitModelId(indexed.id).provider : undefined,
        source: 'user-alias',
        confidence: indexed ? 'exact' : 'high',
      }
    }
  }

  // 2. Exact canonical id.
  const exact = lookupExact(lowerIndex, cleanId)
  if (exact) {
    return {
      discoveredModelId: modelId,
      canonicalModelId: exact.id,
      canonicalProviderId: splitModelId(exact.id).provider,
      source: 'exact',
      confidence: 'exact',
    }
  }

  const requested = splitModelId(cleanId)

  // 3. Namespace-stripped exact: strip a leading gateway namespace and try
  // the remainder against known providers from the index.
  if (requested.provider) {
    const stripped = requested.model
    const strippedExact = lookupExact(lowerIndex, stripped)
    if (strippedExact) {
      return {
        discoveredModelId: modelId,
        canonicalModelId: strippedExact.id,
        canonicalProviderId: splitModelId(strippedExact.id).provider,
        source: 'namespace-stripped',
        confidence: 'high',
      }
    }

    // Try `<known-provider>/<stripped-model>` combos; require a unique hit.
    const candidates: ModelsDevModel[] = []
    for (const provider of collectProviders(bundle, cleanId)) {
      const hit = lookupExact(lowerIndex, provider + '/' + stripped)
      if (hit) candidates.push(hit)
    }
    if (candidates.length === 1) {
      const hit = candidates[0]!
      return {
        discoveredModelId: modelId,
        canonicalModelId: hit.id,
        canonicalProviderId: splitModelId(hit.id).provider,
        source: 'namespace-stripped',
        confidence: 'high',
      }
    }
    if (candidates.length > 1) {
      return {
        discoveredModelId: modelId,
        canonicalModelId: undefined,
        source: 'namespace-stripped',
        confidence: 'none',
        ambiguous: true,
      }
    }
  }

  // 4. Unique model-id exact across all providers.
  const uniqueMatches = findUniqueModelPart(bundle, requested.model)
  if (uniqueMatches.length === 1) {
    const hit = uniqueMatches[0]!
    return {
      discoveredModelId: modelId,
      canonicalModelId: hit.id,
      canonicalProviderId: splitModelId(hit.id).provider,
      source: 'unique-model-id',
      confidence: 'high',
    }
  }
  if (uniqueMatches.length > 1) {
    // Design §17: when the model id matches several hosts but every host
    // exposes the SAME NON-EMPTY reasoning_options, the capability evidence
    // is safe to use even though no single canonical id wins. This is NOT a
    // guess: the controls are identical across all candidates. Empty
    // controls stay ambiguous (nothing safe to derive).
    const firstControls = uniqueMatches[0]!.reasoning_options ?? []
    const sameReasoningControls = firstControls.length > 0 &&
      uniqueMatches.every(
        (candidate) => JSON.stringify(candidate.reasoning_options ?? []) === JSON.stringify(firstControls),
      )
    if (sameReasoningControls) {
      const first = uniqueMatches[0]!
      return {
        discoveredModelId: modelId,
        canonicalModelId: first.id,
        canonicalProviderId: splitModelId(first.id).provider,
        source: 'unique-model-id',
        confidence: 'medium',
        ambiguous: true,
      }
    }
    return {
      discoveredModelId: modelId,
      canonicalModelId: undefined,
      source: 'unique-model-id',
      confidence: 'none',
      ambiguous: true,
    }
  }

  // 5. Safe revision/date suffix match: only when the base resolves to a
  // unique canonical model and the suffix is a strict date/revision marker.
  const revisionMatch = cleanId.match(REVISION_SUFFIX)
  if (revisionMatch) {
    const baseId = cleanId.slice(0, -revisionMatch[0].length)
    const baseExact = lookupExact(lowerIndex, baseId)
    const baseUnique = baseExact ? [baseExact] : findUniqueModelPart(bundle, baseId)
    if (baseUnique.length === 1) {
      const base = baseUnique[0]!
      return {
        discoveredModelId: modelId,
        canonicalModelId: base.id,
        canonicalProviderId: splitModelId(base.id).provider,
        source: 'safe-revision-match',
        confidence: 'high',
      }
    }
  }

  // 6. Nothing safe to resolve.
  return {
    discoveredModelId: modelId,
    canonicalModelId: undefined,
    source: 'none',
    confidence: 'none',
  }
}
