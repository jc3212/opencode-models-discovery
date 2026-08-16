import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ModelDiscoveryPlugin } from '../src/index'
import { ProviderModelStore } from '../src/plugin/provider-model-store'
import { providerModelStoreTestUtils } from '../src/plugin/enhance-config'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'

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
      } catch {
        return { ok: false, models: [] }
      }
    }),
  }
})

global.fetch = mockFetch

/**
 * Phase B cache invalidation tests (design §8, Case Cache-1..4).
 *
 * The persisted model cache stores final model configs including automatic
 * `variants`. If a cached model's variants survive a change to transport,
 * reasoning enablement, metadata, or aliases, stale (wrong) reasoning
 * controls are shown. These tests assert that automatic variants never
 * outlive the config/metadata that produced them.
 */

describe('reasoning cache invalidation', () => {
  let mockClient: any
  let pluginHooks: any
  let cacheRoot: string

  beforeEach(async () => {
    mockFetch.mockClear()
    modelsDevTestUtils.resetCache()
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.OPENCODE
    delete process.env.OPENCODE_PID
    delete process.env.MIMOCODE
    delete process.env.MIMOCODE_PID
    delete process.env.OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED
    cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'models-discovery-cache-'))
    providerModelStoreTestUtils.setStore(new ProviderModelStore(cacheRoot))

    mockClient = {
      app: { log: vi.fn().mockResolvedValue(true) },
      config: { providers: vi.fn().mockResolvedValue({ data: { providers: [] } }) },
      tui: { showToast: vi.fn().mockResolvedValue(true) },
    }

    const mockInput: any = {
      client: mockClient,
      project: { id: 'test-project', name: 'test', path: '/tmp', worktree: '', time: { created: Date.now() } },
      directory: '/tmp',
      worktree: '',
      $: vi.fn(),
      config: {},
    }
    pluginHooks = await ModelDiscoveryPlugin(mockInput)
  })

  afterEach(async () => {
    delete process.env.OPENCODE_AUTH_CONTENT
    delete process.env.OPENCODE
    delete process.env.OPENCODE_PID
    delete process.env.MIMOCODE
    delete process.env.MIMOCODE_PID
    delete process.env.OPENCODE_MODELS_DISCOVERY_DEFAULT_ENABLED
    providerModelStoreTestUtils.resetStore()
    await rm(cacheRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function makeConfig(providerConfig: Record<string, unknown>): any {
    return {
      provider: {
        cached: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:8000/v1',
            modelsDiscovery: { cache: { enabled: true }, ...providerConfig },
          },
          models: {},
        },
      },
    }
  }

  async function seedCache(
    models: Record<string, Record<string, unknown>>,
    reasoningFingerprint?: string,
  ): Promise<void> {
    const store = new ProviderModelStore(cacheRoot)
    await store.saveModels({
      id: 'cached',
      baseURL: 'http://127.0.0.1:8000',
      endpoint: '/v1/models',
    }, models, undefined, reasoningFingerprint)
  }

  it('Case Cache-1: stale variants do not survive a transport change to unknown', async () => {
    await seedCache({
      'gpt-test': {
        id: 'gpt-test',
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
    })

    const config = makeConfig({
      reasoning: { enabled: true, transport: 'auto' },
    })
    await pluginHooks.config(config)

    // Transport auto + unknown host => no safe transport => variants must be {}
    expect(config.provider.cached.models['gpt-test']).toBeDefined()
    expect(config.provider.cached.models['gpt-test'].variants).toBeUndefined()
  })

  it('Case Cache-2: stale variants do not survive reasoning.enabled=false', async () => {
    // The cache was written when reasoning was enabled (a fingerprint is
    // stored). Disabling reasoning must strip the automatic variants.
    await seedCache({
      'gpt-test': {
        id: 'gpt-test',
        variants: {
          low: { reasoningEffort: 'low' },
          medium: { reasoningEffort: 'medium' },
          high: { reasoningEffort: 'high' },
        },
      },
    }, 'some-old-fingerprint')

    const config = makeConfig({
      reasoning: { enabled: false },
    })
    await pluginHooks.config(config)

    expect(config.provider.cached.models['gpt-test']).toBeDefined()
    expect(config.provider.cached.models['gpt-test'].variants).toBeUndefined()
  })

  it('Case Cache-3: stale variants do not survive a metadata update', async () => {
    // First run: metadata says low/medium/high, transport explicit effort.
    // The discovery path calls fetchModelsDevData(), so we inject the catalog
    // through the module-level cache to control what enrichment sees.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: 'list', data: [{ id: 'gpt-test' }] }),
    })
    modelsDevTestUtils.setCacheData({
      openai: {
        models: {
          'gpt-test': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
          },
        },
      },
    })
    const config1 = makeConfig({
      modelInfoFormat: 'models.dev',
      reasoning: { enabled: true, transport: 'openai-compatible-effort' },
    })
    await pluginHooks.config(config1)
    expect(config1.provider.cached.models['gpt-test'].variants).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
    })

    // Metadata updates to low/high. The cached inventory is still fresh, but
    // the metadata fingerprint differs, so stale automatic variants (medium)
    // must not survive the cache read.
    modelsDevTestUtils.setCacheData({
      openai: {
        models: {
          'gpt-test': {
            reasoning: true,
            reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
          },
        },
      },
    })
    const config2 = makeConfig({
      modelInfoFormat: 'models.dev',
      reasoning: { enabled: true, transport: 'openai-compatible-effort' },
    })
    await pluginHooks.config(config2)

    const variants = config2.provider.cached.models['gpt-test'].variants
    expect(variants).toBeUndefined()
  })

  it('Case Cache-4: stale variants do not survive an alias change', async () => {
    await seedCache({
      'vip-model': {
        id: 'vip-model',
        variants: {
          low: { reasoningEffort: 'low' },
          high: { reasoningEffort: 'high' },
        },
      },
    })

    const config = makeConfig({
      reasoning: {
        enabled: true,
        transport: 'openai-compatible-effort',
        aliases: { 'vip-model': 'openai/other-model' },
      },
    })
    await pluginHooks.config(config)

    // The alias changed to a model that does not exist in models.dev, so the
    // old automatic variants (from the previous alias) must not survive.
    expect(config.provider.cached.models['vip-model']).toBeDefined()
    expect(config.provider.cached.models['vip-model'].variants).toBeUndefined()
  })
})
