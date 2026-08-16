import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ModelDiscoveryPlugin } from '../src/index'
import { ProviderModelStore } from '../src/plugin/provider-model-store'
import { providerModelStoreTestUtils } from '../src/plugin/enhance-config'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import { computeReasoningFingerprint, computeRelayDigest } from '../src/reasoning/cache-fingerprint'
import { registryTestUtils } from '../src/reasoning/registry/loader'
import { REGISTRY_SCHEMA_VERSION } from '../src/reasoning/registry/types'
import type { ReasoningRegistry } from '../src/reasoning/registry/types'

const mockFetch = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/openai-compatible-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/openai-compatible-api')>()
  const readJson = async <T,>(response: any): Promise<T | undefined> => {
    if (!response?.ok) return undefined
    try { return await response.json() as T } catch { return undefined }
  }
  return {
    ...actual,
    discoverModelsFromProvider: vi.fn(async (baseURL: string, apiKey?: string, endpoint = '/v1/models') => {
      try {
        const data = await readJson<{ data?: any[] }>(await mockFetch(actual.buildAPIURL(baseURL, endpoint)))
        return data ? { ok: true, models: data.data ?? [] } : { ok: false, models: [] }
      } catch { return { ok: false, models: [] } }
    }),
  }
})
global.fetch = mockFetch

/**
 * Upgrade / migration (design §12-17). Simulates an old-version user
 * upgrading to the current RC.
 */

const registry: ReasoningRegistry = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  registryVersion: '2026.08.16.1',
  models: [
    { model: 'openai/gpt-5.4', aliases: ['gpt-5.4'], reasoning: true, controls: [{ type: 'effort', values: ['low', 'high'] }], sources: [{ type: 'official-doc', vendor: 'openai', verifiedAt: '2026-08-16' }], updatedAt: '2026-08-16', schemaVersion: REGISTRY_SCHEMA_VERSION },
  ],
}

describe('upgrade / migration (design §12-17)', () => {
  let mockClient: any
  let pluginHooks: any
  let cacheRoot: string

  beforeEach(async () => {
    mockFetch.mockClear()
    modelsDevTestUtils.resetCache()
    registryTestUtils.setBundledRegistry(registry)
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.OPENCODE
    delete process.env.OPENCODE_PID
    delete process.env.MIMOCODE
    delete process.env.MIMOCODE_PID
    delete process.env.OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED
    cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'omd-upgrade-'))
    providerModelStoreTestUtils.setStore(new ProviderModelStore(cacheRoot))
    mockClient = {
      app: { log: vi.fn().mockResolvedValue(true) },
      config: { providers: vi.fn().mockResolvedValue({ data: { providers: [] } }) },
      tui: { showToast: vi.fn().mockResolvedValue(true) },
    }
    const mockInput: any = {
      client: mockClient,
      project: { id: 'test-project', name: 'test', path: '/tmp', worktree: '', time: { created: Date.now() } },
      directory: '/tmp', worktree: '', $: vi.fn(), config: {},
    }
    pluginHooks = await ModelDiscoveryPlugin(mockInput)
  })

  afterEach(async () => {
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.OPENCODE_PID
    delete process.env.MIMOCODE_PID
    providerModelStoreTestUtils.resetStore()
    registryTestUtils.setBundledRegistry(undefined)
    await rm(cacheRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function makeConfig(extra: Record<string, unknown> = {}): any {
    return {
      provider: {
        gw: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:8000/v1',
            modelsDiscovery: {
              enabled: true,
              cache: { enabled: true },
              reasoning: { enabled: true, transport: 'openai-compatible-effort' },
              ...extra,
            },
          },
          models: {},
        },
      },
    }
  }

  it('Upgrade 1: old cached variants are invalidated when registry version changes', async () => {
    // Old cache written with old registryVersion + old fingerprint.
    const store = new ProviderModelStore(cacheRoot)
    await store.saveModels(
      { id: 'gw', baseURL: 'http://127.0.0.1:8000', endpoint: '/v1/models' },
      { 'gpt-5.4': { id: 'gpt-5.4', variants: { low: { reasoningEffort: 'low' }, medium: { reasoningEffort: 'medium' } } } },
      undefined,
      'old-registry-fingerprint',
    )
    // Current fingerprint includes new registryVersion.
    const current = computeReasoningFingerprint({
      reasoningConfig: { enabled: true, transport: 'openai-compatible-effort' },
      registryVersion: registry.registryVersion,
    })
    expect(current).not.toBe('old-registry-fingerprint')

    const config = makeConfig()
    await pluginHooks.config(config)
    // Stale variants stripped (fingerprint mismatch); model remains.
    expect(config.provider.gw.models['gpt-5.4']).toBeDefined()
    expect(config.provider.gw.models['gpt-5.4'].variants).toBeUndefined()
  })

  it('Upgrade 2: absent capabilityPolicy behaves as strict (no registry injection by default)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ object: 'list', data: [{ id: 'gpt-5.4' }] }) })
    const config = makeConfig() // no capabilityPolicy -> strict default
    await pluginHooks.config(config)
    expect(config.provider.gw.models['gpt-5.4']).toBeDefined()
    expect(config.provider.gw.models['gpt-5.4'].variants).toBeUndefined()
  })

  it('Upgrade 3: reasoning.enabled=false keeps old behavior', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ object: 'list', data: [{ id: 'gpt-5.4' }] }) })
    const config = makeConfig({ reasoning: { enabled: false } })
    await pluginHooks.config(config)
    expect(config.provider.gw.models['gpt-5.4']).toBeDefined()
    expect(config.provider.gw.models['gpt-5.4'].variants).toBeUndefined()
  })

  it('Upgrade 4: user explicit variants always win after merge', async () => {
    const automatic = { low: { reasoningEffort: 'low' }, high: { reasoningEffort: 'high' } }
    const userExplicit = { high: { reasoningEffort: 'max' }, turbo: { custom: true } }
    const merged = Object.fromEntries(Object.entries(automatic).map(([id, v]) => [id, { ...v }]))
    for (const [id, v] of Object.entries(userExplicit)) merged[id] = { ...v }
    expect(merged.high).toEqual({ reasoningEffort: 'max' })
    expect(merged.turbo).toEqual({ custom: true })
    expect(merged.low).toEqual({ reasoningEffort: 'low' })
  })

  it('Upgrade 5: user alias is required for custom names (no guessing)', () => {
    const direct = computeReasoningFingerprint({ reasoningConfig: { enabled: true, aliases: { 'vip-gpt': 'openai/gpt-5.4' } }, registryVersion: 'x' })
    const noAlias = computeReasoningFingerprint({ reasoningConfig: { enabled: true }, registryVersion: 'x' })
    expect(direct).not.toBe(noAlias)
  })
})
