import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ModelDiscoveryPlugin } from '../src/index'
import { ProviderModelStore } from '../src/plugin/provider-model-store'
import { providerModelStoreTestUtils } from '../src/plugin/enhance-config'
import { modelsDevTestUtils } from '../src/utils/models-dev-fetcher'
import { loadRegistry } from '../src/reasoning/registry/loader'
import { applyReasoningEnrichment } from '../src/reasoning/enricher'
import { normalizeReasoningOptions } from '../src/utils/model-info/reasoning-options'

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
 * Failure injection (design §50-51, §11).
 *
 * Every reasoning-extension failure must fail open: model discovery and the
 * plugin continue; only the failing piece is degraded.
 */

describe('failure injection', () => {
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
    cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'omd-failure-'))
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

  it('corrupt registry JSON never breaks the plugin', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ object: 'list', data: [{ id: 'gpt-test' }] }) })
    const corrupt = loadRegistry({ schemaVersion: 999, registryVersion: 'x', models: [] })
    expect(corrupt).toBeUndefined()

    const config: any = {
      provider: {
        gw: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:8000/v1',
            modelsDiscovery: {
              enabled: true,
              reasoning: { enabled: true, transport: 'openai-compatible-effort', capabilityPolicy: 'official-model' },
            },
          },
          models: {},
        },
      },
    }
    await pluginHooks.config(config)
    expect(config.provider.gw.models['gpt-test']).toBeDefined()
  })

  it('provider A timeout does not break provider B (isolation, design 51)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout')) // provider A fails
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ object: 'list', data: [{ id: 'model-b' }] }) })

    const config: any = {
      provider: {
        a: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9001/v1', modelsDiscovery: { enabled: true } }, models: {} },
        b: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:9002/v1', modelsDiscovery: { enabled: true } }, models: {} },
      },
    }
    await pluginHooks.config(config)
    // B still discovers its model despite A failing.
    expect(config.provider.b.models['model-b']).toBeDefined()
  })

  it('malformed provider metadata never throws in the enricher', () => {
    const modelConfig: Record<string, unknown> = { id: 'x' }
    expect(() => applyReasoningEnrichment({
      modelConfig,
      modelId: 'x',
      providerConfig: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://gw.example.com/v1' } },
      discoveryConfig: { reasoning: { enabled: true, transport: 'openai-compatible-effort' } },
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
      providerMetadata: { reasoning_options: 'not-an-array', owned_by: 123 },
    })).not.toThrow()
    expect(modelConfig.variants).toBeUndefined()
  })

  it('transport resolver exceptions fail open', () => {
    // Unknown npm + unknown host => unknown transport => no variants, no throw.
    const modelConfig: Record<string, unknown> = { id: 'x' }
    applyReasoningEnrichment({
      modelConfig,
      modelId: 'x',
      providerConfig: { npm: 'unknown-sdk', options: { baseURL: 'https://gw.example.com/v1' } },
      discoveryConfig: { reasoning: { enabled: true, transport: 'auto' } },
      modelsDevIndex: modelsDevTestUtils.parseModelsDevData({}),
    })
    expect(modelConfig.variants).toBeUndefined()
  })

  it('models.dev offline returns empty catalog without breaking discovery', async () => {
    // Provider /v1/models resolves first; models.dev fetch then rejects.
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ object: 'list', data: [{ id: 'gpt-test' }] }) })
    mockFetch.mockRejectedValueOnce(new Error('models.dev offline'))

    const config: any = {
      provider: {
        gw: {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'http://127.0.0.1:8000/v1',
            modelsDiscovery: { enabled: true, modelInfoFormat: 'models.dev', reasoning: { enabled: true } },
          },
          models: {},
        },
      },
    }
    await pluginHooks.config(config)
    expect(config.provider.gw.models['gpt-test']).toBeDefined()
  })

  it('unknown future reasoning option types are ignored, not fatal', () => {
    const options = normalizeReasoningOptions([
      { type: 'effort', values: ['low', 'high'] },
      { type: 'new_control', foo: 'bar' },
    ])
    expect(options).toEqual([{ type: 'effort', values: ['low', 'high'] }])
  })
})
