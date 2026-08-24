/**
 * Optional projection acceleration store (v3 plan §9.1 item 2, §8.3).
 *
 * Projections are derived data, never an inventory authority. Each record is
 * keyed by a consumer/pipeline hash supplied by the caller and contains only
 * the exact identity hash, plan generation and already-sanitized selection
 * keys. A V2 transform must still start from a fresh host draft; this store
 * only shortens local startup work.
 */

import { type HmacSecret, hmacHex } from '../discovery/identity'
import { readJsonOptional, writeJsonAtomic } from './safe-file'

const PROJECTION_DIR = 'projections/v2'

export interface ProjectionRecordV2 {
  schemaVersion: 2
  consumerKeyHash: string
  pipelineHash: string
  identityHash: string
  planGeneration: number
  projectionState: 'no-contribution' | 'explicit-only' | 'unresolved-deny' | 'fresh' | 'stale-allowed' | 'strict-empty' | 'auth-blocked' | 'disposed'
  selectionKeys: string[]
  pluginOwnedSelectionKeys: string[]
  createdAt: string
  sourceRevision?: string
}

export interface ProjectionStoreKeyInput {
  cacheRoot: string
  secret: HmacSecret
  consumerKeyHash: string
  pipelineHash: string
}

function hashInput(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${field} must be a 64-char lowercase hex hash`)
  }
}

function projectionFileName(input: ProjectionStoreKeyInput): string {
  hashInput(input.consumerKeyHash, 'consumerKeyHash')
  hashInput(input.pipelineHash, 'pipelineHash')
  return `${hmacHex(input.secret, `projection-v2\n${input.consumerKeyHash}\n${input.pipelineHash}`)}.json`
}

function projectionPath(input: ProjectionStoreKeyInput): string {
  return projectionFileName(input)
}

function sortedUniqueKeys(values: readonly string[]): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).sort()
}

export interface SaveProjectionOptions extends ProjectionStoreKeyInput {
  identityHash: string
  planGeneration: number
  projectionState: ProjectionRecordV2['projectionState']
  selectionKeys: readonly string[]
  pluginOwnedSelectionKeys: readonly string[]
  sourceRevision?: string
  createdAt?: string
}

export async function saveProjection(options: SaveProjectionOptions): Promise<string> {
  hashInput(options.identityHash, 'identityHash')
  if (!Number.isSafeInteger(options.planGeneration) || options.planGeneration < 0) {
    throw new TypeError('planGeneration must be a non-negative safe integer')
  }
  const record: ProjectionRecordV2 = {
    schemaVersion: 2,
    consumerKeyHash: options.consumerKeyHash,
    pipelineHash: options.pipelineHash,
    identityHash: options.identityHash,
    planGeneration: options.planGeneration,
    projectionState: options.projectionState,
    selectionKeys: sortedUniqueKeys(options.selectionKeys),
    pluginOwnedSelectionKeys: sortedUniqueKeys(options.pluginOwnedSelectionKeys),
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.sourceRevision !== undefined ? { sourceRevision: options.sourceRevision } : {}),
  }
  return writeJsonAtomic(options.cacheRoot, PROJECTION_DIR, projectionPath(options), record)
}

function isProjectionRecord(value: unknown): value is ProjectionRecordV2 {
  if (!value || typeof value !== 'object') return false
  const record = value as ProjectionRecordV2
  return record.schemaVersion === 2 &&
    typeof record.consumerKeyHash === 'string' &&
    typeof record.pipelineHash === 'string' &&
    typeof record.identityHash === 'string' &&
    Number.isSafeInteger(record.planGeneration) &&
    typeof record.projectionState === 'string' &&
    Array.isArray(record.selectionKeys) && record.selectionKeys.every((item) => typeof item === 'string') &&
    Array.isArray(record.pluginOwnedSelectionKeys) && record.pluginOwnedSelectionKeys.every((item) => typeof item === 'string') &&
    typeof record.createdAt === 'string'
}

export interface LoadProjectionOptions extends ProjectionStoreKeyInput {
  expectedIdentityHash?: string
  minimumPlanGeneration?: number
}

export async function loadProjection(
  options: LoadProjectionOptions,
): Promise<ProjectionRecordV2 | undefined> {
  const file = projectionFileName(options)
  const result = await readJsonOptional<ProjectionRecordV2>(
    `${options.cacheRoot}/${PROJECTION_DIR}/${file}`,
  )
  if (!result.ok || !isProjectionRecord(result.value)) return undefined
  if (result.value.consumerKeyHash !== options.consumerKeyHash || result.value.pipelineHash !== options.pipelineHash) return undefined
  if (options.expectedIdentityHash !== undefined && result.value.identityHash !== options.expectedIdentityHash) return undefined
  if (options.minimumPlanGeneration !== undefined && result.value.planGeneration < options.minimumPlanGeneration) return undefined
  return result.value
}
