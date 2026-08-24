/**
 * Public-metadata verified revision store (v3 plan §12.1; WP7/E12).
 *
 * Startup reads the LOCAL verified bundle only — this module performs no
 * network I/O by construction; fetching belongs to CLI/V2-Effect updaters
 * that honor HTTPS allowlists and ETag/If-Modified-Since. Provider keys are
 * never part of any snapshot.
 *
 * Fail-closed envelope validation enforces §12.1 limits: byte budget
 * (pre/post serialization), nesting depth, string lengths, provider/model
 * counts, duplicate `(provider, model)` tuples, and prototype-pollution
 * keys anywhere in the tree.
 *
 * A candidate update is QUARANTINED instead of replacing the activated
 * bundle when it would empty the catalog, delete an anomalous share of
 * models, or add a positive reasoning expansion out of nowhere.
 */

import { createHash } from 'node:crypto'
import { readJsonOptional, writeJsonAtomic } from '../cache/safe-file'

const METADATA_DIR = 'metadata/v1'

export interface MetadataLimits {
  maxSerializedBytes: number
  maxDepth: number
  maxStringLength: number
  maxProviders: number
  maxModelsPerProvider: number
  /** Share of previously-known models that may vanish in one update. */
  maxDeleteRatio: number
}

export const DEFAULT_METADATA_LIMITS: MetadataLimits = Object.freeze({
  maxSerializedBytes: 4_000_000,
  maxDepth: 8,
  maxStringLength: 4096,
  maxProviders: 512,
  maxModelsPerProvider: 2048,
  maxDeleteRatio: 0.5,
})

export interface MetadataReasoningV1 {
  supportedEfforts?: readonly string[] | null
  defaultEffort?: string
}

export interface MetadataModelV1 {
  id: string
  canonicalModelId?: string
  reasoning?: MetadataReasoningV1
}

export interface MetadataProviderV1 {
  id: string
  npm?: string
  models: MetadataModelV1[]
}

export interface MetadataSnapshotV1 {
  schemaVersion: 1
  revision: string
  fetchedAt: string
  providers: MetadataProviderV1[]
}

export type SnapshotValidationResult =
  | { ok: true; value: MetadataSnapshotV1 }
  | { ok: false; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function checkNoPrototypeKeys(value: unknown, depth: number, limits: MetadataLimits): boolean {
  if (depth > limits.maxDepth) return false
  if (Array.isArray(value)) {
    return value.every((item) => checkNoPrototypeKeys(item, depth + 1, limits))
  }
  if (!isPlainObject(value)) return typeof value !== 'string' || value.length <= limits.maxStringLength
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
    if (typeof value[key] === 'string' && (value[key] as string).length > limits.maxStringLength) {
      return false
    }
    if (!checkNoPrototypeKeys(value[key], depth + 1, limits)) return false
  }
  return true
}

function requireNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Validates one raw parsed document against the v1 envelope schema and the
 * §12.1 limits. Fail-closed: any surprise rejects the WHOLE document.
 */
export function validateMetadataSnapshot(
  raw: unknown,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
): SnapshotValidationResult {
  const serializedLength = JSON.stringify(raw ?? null)?.length ?? 0
  if (serializedLength > limits.maxSerializedBytes) {
    return { ok: false, reason: `snapshot exceeds byte limit (${serializedLength})` }
  }
  if (!checkNoPrototypeKeys(raw, 0, limits)) {
    return { ok: false, reason: 'snapshot violates depth/string/prototype-key limits' }
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'snapshot must be a JSON object' }
  if (raw.schemaVersion !== 1) return { ok: false, reason: 'schemaVersion must be 1' }
  if (!requireNonEmptyString(raw.revision)) return { ok: false, reason: 'revision required' }
  if (!requireNonEmptyString(raw.fetchedAt)) return { ok: false, reason: 'fetchedAt required' }
  if (!Number.isFinite(Date.parse(raw.fetchedAt))) {
    return { ok: false, reason: 'fetchedAt must be ISO-8601' }
  }
  if (!Array.isArray(raw.providers)) return { ok: false, reason: 'providers must be an array' }
  if (raw.providers.length > limits.maxProviders) {
    return { ok: false, reason: `too many providers (${raw.providers.length})` }
  }

  const seenTuples = new Set<string>()
  for (const provider of raw.providers as unknown[]) {
    if (!isPlainObject(provider)) return { ok: false, reason: 'provider must be an object' }
    if (!requireNonEmptyString(provider.id)) return { ok: false, reason: 'provider id required' }
    if (!Array.isArray(provider.models)) return { ok: false, reason: 'provider.models must be an array' }
    if (provider.models.length > limits.maxModelsPerProvider) {
      return { ok: false, reason: `too many models for ${provider.id}` }
    }
    for (const model of provider.models as unknown[]) {
      if (!isPlainObject(model)) return { ok: false, reason: 'model must be an object' }
      if (!requireNonEmptyString(model.id)) return { ok: false, reason: 'model id required' }
      const tuple = `${provider.id}\u0000${model.id}`
      if (seenTuples.has(tuple)) {
        return { ok: false, reason: `duplicate tuple ${JSON.stringify(provider.id)}×${JSON.stringify(model.id)}` }
      }
      seenTuples.add(tuple)
      if (model.reasoning !== undefined) {
        if (!isPlainObject(model.reasoning)) {
          return { ok: false, reason: 'model.reasoning must be an object when present' }
        }
        const efforts = model.reasoning.supportedEfforts
        if (efforts !== undefined && efforts !== null && !Array.isArray(efforts)) {
          return { ok: false, reason: 'supportedEfforts must be an array or null' }
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      revision: raw.revision,
      fetchedAt: raw.fetchedAt,
      providers: raw.providers as MetadataProviderV1[],
    },
  }
}

export type UpdateDecision =
  | { decision: 'accept' }
  | { decision: 'quarantine'; reasons: string[] }

function modelKey(provider: MetadataProviderV1, model: MetadataModelV1): string {
  return `${provider.id}\u0000${model.id}`
}

function reasoningSignature(model: MetadataModelV1): string {
  const r = model.reasoning
  if (r === undefined) return 'none'
  if (r.supportedEfforts === null) return 'open-ended'
  if (r.supportedEfforts === undefined) return 'none'
  return [...r.supportedEfforts].sort().join(',')
}

/**
 * Compares a candidate against the ACTIVATED snapshot. Quarantine triggers:
 * empty candidate catalog, anomalous deletion ratio, or positive reasoning
 * expansion appearing from nowhere (§12.1).
 */
export function decideUpdate(
  activated: MetadataSnapshotV1 | undefined,
  candidate: MetadataSnapshotV1,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
): UpdateDecision {
  const reasons: string[] = []
  const totalModels = (snapshot: MetadataSnapshotV1): number =>
    snapshot.providers.reduce((sum, p) => sum + p.models.length, 0)

  if (candidate.providers.length === 0 || totalModels(candidate) === 0) {
    reasons.push('candidate-catalog-empty')
  }

  if (activated !== undefined) {
    const known = new Map<string, string>()
    for (const provider of activated.providers) {
      for (const model of provider.models) known.set(modelKey(provider, model), reasoningSignature(model))
    }
    const stillKnown = new Set<string>()
    let deletions = 0
    for (const provider of candidate.providers) {
      for (const model of provider.models) {
        const key = modelKey(provider, model)
        stillKnown.add(key)
        const previousSignature = known.get(key)
        if (previousSignature === 'none' && reasoningSignature(model) !== 'none') {
          reasons.push(`reasoning-expansion:${key}`)
        }
      }
    }
    for (const key of known.keys()) {
      if (!stillKnown.has(key)) deletions += 1
    }
    if (known.size > 0 &&
        deletions / known.size > limits.maxDeleteRatio) {
      reasons.push(`delete-ratio:${deletions}/${known.size}`)
    }
  }

  return reasons.length === 0 ? { decision: 'accept' } : { decision: 'quarantine', reasons }
}

function revisionFileName(revision: string): string {
  // Full 64-char lowercase hex: satisfies safe-file full-hash naming.
  return `${createHash('sha256').update(revision).digest('hex')}.json`
}

/**
 * Persists a validated candidate as its own revision file. There is NO
 * pointer file: a corrupted write can never strand the store, because
 * loading scans revisions and picks the newest VALID one (crash recovery
 * by construction). The caller MUST run validateMetadataSnapshot +
 * decideUpdate first; this function re-validates fail-closed anyway.
 */
export async function saveVerifiedSnapshot(
  cacheRoot: string,
  snapshot: MetadataSnapshotV1,
): Promise<{ path: string }> {
  const validation = validateMetadataSnapshot(snapshot)
  if (!validation.ok) throw new TypeError(`refusing to store invalid snapshot: ${validation.reason}`)
  const path = await writeJsonAtomic(
    cacheRoot,
    METADATA_DIR,
    revisionFileName(snapshot.revision),
    snapshot,
  )
  return { path }
}

async function readRevisionFile(
  cacheRoot: string,
  fileName: string,
): Promise<MetadataSnapshotV1 | undefined> {
  const result = await readJsonOptional<unknown>(`${cacheRoot}/${METADATA_DIR}/${fileName}`)
  if (!result.ok) return undefined
  const validation = validateMetadataSnapshot(result.value)
  return validation.ok ? validation.value : undefined
}

/**
 * Loads the local verified snapshot. ZERO NETWORK: scans stored revision
 * files and returns the newest VALID one (newest `fetchedAt`, tie-break on
 * `revision`), skipping any structurally invalid file — crash recovery by
 * construction. Returns undefined when no valid local bundle exists.
 */
export async function loadLocalVerifiedSnapshot(
  cacheRoot: string,
): Promise<MetadataSnapshotV1 | undefined> {
  const { readdir } = await import('node:fs/promises')
  let entries: string[]
  try {
    entries = await readdir(`${cacheRoot}/${METADATA_DIR}`)
  } catch {
    return undefined
  }
  let best: MetadataSnapshotV1 | undefined
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const snapshot = await readRevisionFile(cacheRoot, name)
    if (snapshot === undefined) continue
    if (best === undefined ||
        snapshot.fetchedAt > best.fetchedAt ||
        (snapshot.fetchedAt === best.fetchedAt && snapshot.revision >= best.revision)) {
      best = snapshot
    }
  }
  return best
}
