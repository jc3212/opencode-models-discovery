import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ModelDiscoveryPlugin } from '../src/index'
import { ProviderModelStore } from '../src/plugin/provider-model-store'
import { providerModelStoreTestUtils } from '../src/plugin/enhance-config'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import { normalizeReasoningOptions } from '../src/utils/model-info/reasoning-options'
import { resolveReasoningCapability } from '../src/reasoning/resolver'
import { resolveReasoningForModel } from '../src/reasoning/enricher'
import type { ProviderDiscoveryConfig } from '../src/types/plugin-config'

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
 * Phase P/Q/R regression coverage (design §44, §45, §46-47).
 */

describe('reasoning disabled regression (Phase P)', () => {
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
    cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'models-discovery-disabled-'))
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
    await rm(cacheRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reasoning disabled produces no variants but discovery still runs', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ object: 'list', data: [{ id: 'gpt-test' }] }),
    })
    modelsDevTestUtils.setCacheData({
      openai: { models: { 'gpt-test': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } },
    })

    const config: any = {
      provider: {
        disabled: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:8000/v1',
            modelsDiscovery: {
              enabled: true,
              modelInfoFormat: 'models.dev',
              reasoning: { enabled: false },
            },
          },
          models: {},
        },
      },
    }
    await pluginHooks.config(config)

    expect(config.provider.disabled.models['gpt-test']).toBeDefined()
    expect(config.provider.disabled.models['gpt-test'].variants).toBeUndefined()
    // Other enrichment (reasoning flag) still applied.
    expect(config.provider.disabled.models['gpt-test'].reasoning).toBe(true)
  })
})

describe('failure isolation (Phase Q)', () => {
  it('malformed reasoning_options never throws in normalization', () => {
    expect(() => normalizeReasoningOptions([
      { type: 'effort', values: [1, null] },
      { type: 'new_control' },
      'garbage',
      { type: 'toggle' },
    ])).not.toThrow()
    const options = normalizeReasoningOptions([{ type: 'effort', values: [1, null] }, { type: 'new_control' }, 'garbage', { type: 'toggle' }])
    // Unknown option types are dropped; valid options survive.
    expect(options).toEqual([{ type: 'toggle' }])
  })

  it('future unknown reasoning option types are ignored with the rest preserved', () => {
    const options = normalizeReasoningOptions([
      { type: 'effort', values: ['low', 'high'] },
      { type: 'new_control', foo: 'bar' },
    ])
    expect(options).toEqual([{ type: 'effort', values: ['low', 'high'] }])
  })

  it('resolveReasoningCapability fails open on malformed provider metadata', () => {
    const result = resolveReasoningCapability({
      providerNative: { reasoning_options: 'not-an-array' },
    })
    expect(result.reasoning).toBe(false)
    expect(() => resolveReasoningCapability({ providerNative: null })).not.toThrow()
  })

  it('resolveReasoningForModel fails open when transport resolver has no signals', () => {
    const result = resolveReasoningForModel({
      modelId: 'gpt-test',
      providerConfig: {},
      discoveryConfig: { reasoning: { enabled: true } } as ProviderDiscoveryConfig,
    })
    expect(result).toBeDefined()
    expect(result.transport.safeToCompile).toBe(false)
  })
})

describe('performance: catalog reused, no per-model lookups (Phase R)', () => {
  it('resolveReasoningForModel uses an in-memory index, not per-model fetches', () => {
    // Build an index once (like fetchModelsDevData does) and resolve 1000
    // models. This exercises the O(n) path without any network.
    const index = modelsDevTestUtils.parseModelsDevData({
      openai: {
        models: {
          'gpt-5': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
          'gpt-5-mini': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
        },
      },
    })

    const started = performance.now()
    for (let i = 0; i < 1000; i++) {
      const modelId = i % 2 === 0 ? 'gpt-5' : 'gpt-5-mini'
      const result = resolveReasoningForModel({
        modelId,
        providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
        discoveryConfig: { reasoning: { enabled: true, transport: 'openai-compatible-effort' } } as ProviderDiscoveryConfig,
        modelsDevIndex: index,
      })
      expect(result).toBeDefined()
    }
    const elapsed = performance.now() - started
    // 1000 pure resolutions should be well under 1s.
    expect(elapsed).toBeLessThan(1000)
  })
})
