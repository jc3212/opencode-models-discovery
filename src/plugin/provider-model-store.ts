import { promises as fs } from 'node:fs'
import path from 'node:path'
import { xdgData } from 'xdg-basedir'
import { isValidModel } from '../utils/openai-compatible-api'

const STATE_VERSION = 2
const PLUGIN_DATA_DIRECTORY = 'opencode-models-discovery'
const PROVIDERS_DIRECTORY = 'providers'

export interface ProviderModelStoreIdentity {
  id: string
  baseURL: string
  endpoint: string
}

export type ProviderModelOverride = Record<string, unknown>

export interface ProviderModelState {
  version: typeof STATE_VERSION
  provider: ProviderModelStoreIdentity
  fetchedAt: string
  models: Record<string, Record<string, unknown> & { id: string }>
  overrides?: Record<string, ProviderModelOverride>
  /**
   * Fingerprint of the reasoning config + metadata that produced the cached
   * automatic variants. When the current fingerprint differs, cached
   * automatic variants are stale and are stripped on read.
   */
  reasoningFingerprint?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasSameIdentity(actual: ProviderModelStoreIdentity, expected: ProviderModelStoreIdentity): boolean {
  return actual.id === expected.id && actual.baseURL === expected.baseURL && actual.endpoint === expected.endpoint
}

function isIdentity(value: unknown): value is ProviderModelStoreIdentity {
  return isPlainObject(value) &&
    typeof value.id === 'string' &&
    typeof value.baseURL === 'string' &&
    typeof value.endpoint === 'string'
}

function isOverrides(value: unknown): value is Record<string, ProviderModelOverride> {
  return isPlainObject(value) && Object.entries(value).every(([modelID, override]) => modelID.length > 0 && isPlainObject(override))
}

function isProviderModelState(value: unknown): value is ProviderModelState {
  if (!isPlainObject(value) || value.version !== STATE_VERSION || !isIdentity(value.provider) ||
    typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)) ||
    !isPlainObject(value.models) || !Object.entries(value.models).every(([modelID, model]) =>
      modelID.length > 0 && isValidModel(model) && model.id === modelID)) {
    return false
  }

  if (value.reasoningFingerprint !== undefined && typeof value.reasoningFingerprint !== 'string') {
    return false
  }

  return value.overrides === undefined || isOverrides(value.overrides)
}

function removeSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeSensitiveFields)
  }

  if (!isPlainObject(value)) {
    return value
  }

  const cleaned: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (/^(api[-_]?key|authorization|token|password|secret|credentials?)$/i.test(key)) {
      continue
    }
    cleaned[key] = removeSensitiveFields(child)
  }
  return cleaned
}

function sanitizeModels(models: Record<string, Record<string, unknown> & { id: string }>): Record<string, Record<string, unknown> & { id: string }> {
  return Object.fromEntries(Object.entries(models).map(([modelID, model]) => [
    modelID,
    removeSensitiveFields(model) as Record<string, unknown> & { id: string },
  ]))
}

export function getProviderStateFileName(providerID: string): string {
  return `provider-${encodeURIComponent(providerID)}.json`
}

export function isInventoryFresh(state: ProviderModelState, ttlSeconds: number, now: number = Date.now()): boolean {
  return Date.parse(state.fetchedAt) + ttlSeconds * 1000 > now
}

export class ProviderModelStore {
  private readonly providersDirectory: string | undefined

  constructor(rootDirectory: string | undefined = xdgData) {
    this.providersDirectory = rootDirectory
      ? path.join(rootDirectory, PLUGIN_DATA_DIRECTORY, PROVIDERS_DIRECTORY)
      : undefined
  }

  getStatePath(providerID: string): string | undefined {
    return this.providersDirectory ? path.join(this.providersDirectory, getProviderStateFileName(providerID)) : undefined
  }

  async read(identity: ProviderModelStoreIdentity): Promise<ProviderModelState | undefined> {
    const statePath = this.getStatePath(identity.id)
    if (!statePath) {
      return undefined
    }

    try {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as unknown
      return isProviderModelState(state) && hasSameIdentity(state.provider, identity) ? state : undefined
    } catch {
      return undefined
    }
  }

  async saveModels(
    identity: ProviderModelStoreIdentity,
    models: Record<string, Record<string, unknown> & { id: string }>,
    previousState?: ProviderModelState,
    reasoningFingerprint?: string
  ): Promise<boolean> {
    const statePath = this.getStatePath(identity.id)
    if (!statePath) {
      return false
    }

    const state: ProviderModelState = {
      version: STATE_VERSION,
      provider: identity,
      fetchedAt: new Date().toISOString(),
      models: sanitizeModels(models),
      ...(previousState?.overrides && Object.keys(previousState.overrides).length > 0
        ? { overrides: previousState.overrides }
        : {}),
      ...(reasoningFingerprint !== undefined ? { reasoningFingerprint } : {}),
    }
    const temporaryPath = path.join(path.dirname(statePath), `.${path.basename(statePath)}.${process.pid}.${Date.now()}.tmp`)

    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
      await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temporaryPath, statePath)
      return true
    } catch {
      try {
        await fs.unlink(temporaryPath)
      } catch {
        // A failed cleanup must not affect discovery.
      }
      return false
    }
  }
}

export function createProviderModelStore(rootDirectory?: string): ProviderModelStore {
  return new ProviderModelStore(rootDirectory)
}

export function mergeModelOverride(base: Record<string, unknown>, override: ProviderModelOverride | undefined): Record<string, unknown> {
  if (!override) {
    return base
  }

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (key === 'id') {
      continue
    }

    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value)
      ? mergeModelOverride(current, value)
      : value
  }
  return merged
}
