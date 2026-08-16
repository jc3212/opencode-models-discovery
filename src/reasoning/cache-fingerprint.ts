import type { ProviderReasoningConfig } from '../types/plugin-config'
import type { ModelInfoFormat } from '../types/plugin-config'
import type { ModelsDevModel } from '../utils/models-dev-fetcher'

/**
 * Reasoning resolution fingerprint (design §9).
 *
 * Automatic `model.variants` are derived from a small set of inputs:
 *   - reasoning config (enabled, transport, aliases)
 *   - metadata source (modelInfoFormat)
 *   - the metadata itself (models.dev content)
 *
 * The persisted cache stores final model configs including automatic
 * variants. If any of these inputs change, cached automatic variants are
 * stale and must not survive. This module computes a deterministic
 * fingerprint so the cache can detect staleness without re-resolving every
 * model.
 *
 * All functions here are pure and deterministic.
 */

export interface ReasoningFingerprintInput {
  reasoningConfig?: ProviderReasoningConfig
  modelInfoFormat?: ModelInfoFormat
  /** Hash of the models.dev metadata used to derive variants. */
  metadataSignature?: string
}

/** FNV-1a 32-bit hex; deterministic, dependency-free. */
export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * Computes the reasoning fingerprint for the current configuration.
 * Returns `undefined` when reasoning is disabled (no automatic variants can
 * be produced), so a cached state that was written with reasoning enabled is
 * detected as stale.
 */
export function computeReasoningFingerprint(input: ReasoningFingerprintInput): string | undefined {
  if (input.reasoningConfig?.enabled === false) {
    return undefined
  }

  const aliases = input.reasoningConfig?.aliases
    ? Object.entries(input.reasoningConfig.aliases)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, v])
    : undefined

  const payload = {
    enabled: input.reasoningConfig?.enabled ?? true,
    transport: input.reasoningConfig?.transport ?? 'auto',
    aliases,
    modelInfoFormat: input.modelInfoFormat ?? null,
    metadataSignature: input.metadataSignature ?? null,
  }

  return hashString(JSON.stringify(payload))
}

/**
 * Deterministic signature of the reasoning-relevant content of a models.dev
 * cache: model id, reasoning flag, and reasoning_options. Changes whenever
 * the catalog updates reasoning controls for any model.
 */
export function computeMetadataSignature(cache: Map<string, ModelsDevModel>): string {
  const entries = [...cache.entries()]
    .map(([id, model]) =>
      id + ':' + (model.reasoning ? '1' : '0') + ':' + JSON.stringify(model.reasoning_options ?? []),
    )
    .sort()
  return hashString(entries.join('|'))
}
