/**
 * models.dev data access - BUNDLED SNAPSHOT ONLY (G4 §3.4).
 *
 * G4.1 removed all runtime network access to models.dev. The snapshot is
 * produced by `registry:sync-models-dev` (explicit, dev/CI only) and embedded
 * into src/generated/models-dev-snapshot.json at compile time. Runtime
 * resolution is deterministic and offline.
 *
 * The public shape (ModelsDevModel, lookupModelsDevData, fetchModelsDevData)
 * is unchanged from the pre-G4 implementation.
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeReasoningOptions } from './model-info/reasoning-options'
import type { ReasoningOption } from '../reasoning/types'
import type { ModelsDevSnapshot, SnapshotEntry } from './models-dev-snapshot'

export interface ModelsDevModel {
  id: string
  name?: string
  attachment?: boolean
  reasoning?: boolean
  /** Host-side reasoning controls exposed by the API surface. */
  reasoning_options?: ReasoningOption[]
  tool_call?: boolean
  structured_output?: boolean
  temperature?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
  limit?: {
    context?: number
    input?: number
    output?: number
  }
}

const PREFIX_MATCH_MIN_SCORE = 70
const PREFIX_MATCH_MIN_SHARED_PARTS = 2

let modelsDevCache: Map<string, ModelsDevModel> | null = null

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toModelId(providerId: string | undefined, modelId: string): string {
  return providerId ? providerId + '/' + modelId : modelId
}

function entryToModel(entry: SnapshotEntry): ModelsDevModel {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    reasoning_options: entry.reasoningOptions,
  }
}

/** Builds the runtime lookup map from a bundled snapshot (local, offline). */
export function buildMapFromSnapshot(snapshot: ModelsDevSnapshot): Map<string, ModelsDevModel> {
  const cache = new Map<string, ModelsDevModel>()
  for (const entry of snapshot.providerModels) {
    const key = entry.id.includes('/') ? entry.id : toModelId(entry.provider, entry.id)
    cache.set(key, entryToModel(entry))
  }
  for (const entry of snapshot.models) {
    // Provider-agnostic facts fill gaps (e.g. display name); never overwrite
    // provider-scoped capability data.
    const key = entry.id
    const existing = cache.get(key)
    if (!existing) {
      cache.set(key, entryToModel(entry))
    } else if (entry.name && existing.name === undefined) {
      cache.set(key, { ...existing, name: entry.name })
    }
  }
  return cache
}

function loadBundledSnapshot(): ModelsDevSnapshot | undefined {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.join(dir, '../generated/models-dev-snapshot.json'),
    path.join(dir, '../src/generated/models-dev-snapshot.json'),
    path.join(dir, 'generated/models-dev-snapshot.json'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, 'utf8')) as ModelsDevSnapshot
      }
    }
  } catch {
    /* fail-open: no snapshot means no models.dev facts */
  }
  return undefined
}

/**
 * Returns models.dev facts for the current process.
 *
 * G4.1: reads the bundled snapshot. If absent (e.g. source checkout before a
 * sync), returns an empty map - never a network call.
 */
export async function fetchModelsDevData(): Promise<Map<string, ModelsDevModel>> {
  if (modelsDevCache) return modelsDevCache
  const snapshot = loadBundledSnapshot()
  modelsDevCache = snapshot ? buildMapFromSnapshot(snapshot) : new Map()
  return modelsDevCache
}

function splitModelId(modelId: string): { provider?: string; model: string } {
  const parts = modelId.split('/')
  if (parts.length <= 1) {
    return { model: modelId }
  }
  return { provider: parts.slice(0, -1).join('/'), model: parts[parts.length - 1] ?? '' }
}

function calculatePrefixScore(requested: string, candidate: string): number {
  const partsA = requested.split('-')
  const partsB = candidate.split('-')
  const shorter = partsA.length <= partsB.length ? partsA : partsB
  const longer = partsA.length <= partsB.length ? partsB : partsA

  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) {
      return 0
    }
  }

  if (shorter.length < PREFIX_MATCH_MIN_SHARED_PARTS) {
    return 0
  }

  return Math.max(0, 100 - ((longer.length - shorter.length) * 10))
}

export function lookupModelsDevData(
  modelId: string,
  cache: Map<string, ModelsDevModel>
): ModelsDevModel | undefined {
  let cleanId = modelId.replace(/:[a-zA-Z0-9_-]+$/g, '')
  const parts = cleanId.split('/')
  if (parts.length > 2) {
    cleanId = parts.slice(-2).join('/')
  }

  const exactMatch = cache.get(cleanId) ?? cache.get(cleanId.toLowerCase())
  if (exactMatch) return exactMatch

  const requestedModelLower = splitModelId(cleanId).model.toLowerCase()
  const allCandidates: Array<[string, ModelsDevModel]> = []

  for (const [key, value] of cache.entries()) {
    const candidate = splitModelId(key)
    const candidateModelLower = candidate.model.toLowerCase()
    allCandidates.push([candidateModelLower, value])
  }

  const exactModelMatches = allCandidates.filter(([candidateModel]) => candidateModel === requestedModelLower)
  if (exactModelMatches.length === 1) return exactModelMatches[0]?.[1]
  if (exactModelMatches.length > 1) return undefined

  let bestMatch: ModelsDevModel | undefined
  let bestScore = 0
  let bestScoreMatches = 0

  for (const [candidateModel, value] of allCandidates) {
    const score = calculatePrefixScore(requestedModelLower, candidateModel)
    if (score >= PREFIX_MATCH_MIN_SCORE && score > bestScore) {
      bestScore = score
      bestMatch = value
      bestScoreMatches = 1
    } else if (score >= PREFIX_MATCH_MIN_SCORE && score === bestScore) {
      bestScoreMatches++
    }
  }

  return bestScoreMatches === 1 ? bestMatch : undefined
}


/**
 * Legacy parser for the raw api.json shape (provider -> { models: {...} } or
 * flat model map). Retained as a test/back-compat utility; the runtime lookup
 * map is now built from the bundled snapshot via buildMapFromSnapshot.
 */
function parseModelsDevData(data: unknown): Map<string, ModelsDevModel> {
  const cache = new Map<string, ModelsDevModel>()

  if (!isObject(data)) {
    return cache
  }

  for (const [key, value] of Object.entries(data)) {
    if (!isObject(value)) {
      continue
    }

    if (isObject(value.models)) {
      for (const [modelId, model] of Object.entries(value.models)) {
        if (isObject(model)) {
          addLegacyModel(cache, key, model, modelId)
        }
      }
      continue
    }

    addLegacyModel(cache, undefined, value, key)
  }

  return cache
}

function addLegacyModel(cache: Map<string, ModelsDevModel>, providerId: string | undefined, rawModel: Record<string, any>, fallbackModelId?: string): void {
  const rawId = typeof rawModel.id === 'string' && rawModel.id.length > 0 ? rawModel.id : fallbackModelId
  if (!rawId) {
    return
  }

  const id = rawId.includes('/') ? rawId : toModelId(providerId, rawId)
  cache.set(id, {
    id,
    name: typeof rawModel.name === 'string' ? rawModel.name : undefined,
    attachment: typeof rawModel.attachment === 'boolean' ? rawModel.attachment : undefined,
    reasoning: typeof rawModel.reasoning === 'boolean' ? rawModel.reasoning : undefined,
    reasoning_options: rawModel.reasoning_options !== undefined
      ? normalizeReasoningOptions(rawModel.reasoning_options)
      : undefined,
    tool_call: typeof rawModel.tool_call === 'boolean' ? rawModel.tool_call : undefined,
    structured_output: typeof rawModel.structured_output === 'boolean' ? rawModel.structured_output : undefined,
    temperature: typeof rawModel.temperature === 'boolean' ? rawModel.temperature : undefined,
    modalities: isObject(rawModel.modalities) ? {
      input: Array.isArray(rawModel.modalities.input) ? rawModel.modalities.input.filter((item: unknown): item is string => typeof item === 'string') : undefined,
      output: Array.isArray(rawModel.modalities.output) ? rawModel.modalities.output.filter((item: unknown): item is string => typeof item === 'string') : undefined,
    } : undefined,
    limit: isObject(rawModel.limit) ? {
      context: typeof rawModel.limit.context === 'number' ? rawModel.limit.context : undefined,
      input: typeof rawModel.limit.input === 'number' ? rawModel.limit.input : undefined,
      output: typeof rawModel.limit.output === 'number' ? rawModel.limit.output : undefined,
    } : undefined,
  })
}

function isSnapshotShape(data: unknown): boolean {
  return !!data && typeof data === 'object' && Array.isArray((data as { providerModels?: unknown }).providerModels)
}

export const modelsDevTestUtils = {
  parseModelsDevData,
  buildMapFromSnapshot,
  resetCache(): void {
    modelsDevCache = null
  },
  /** Inject a fixed map for tests (no disk, no network). */
  setCacheData(data: unknown): Map<string, ModelsDevModel> {
    if (data instanceof Map) {
      modelsDevCache = data
    } else if (isSnapshotShape(data)) {
      modelsDevCache = buildMapFromSnapshot(data as ModelsDevSnapshot)
    } else {
      // Legacy provider-nested / flat api.json shape (pre-G4 tests).
      modelsDevCache = parseModelsDevData(data)
    }
    return modelsDevCache
  },
}