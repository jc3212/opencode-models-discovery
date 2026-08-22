import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { enhanceConfig } from '../src/plugin/enhance-config'
import { classifyProviderPlan } from '../src/discovery/provider-plan'
import { discoverModelsFromProvider } from '../src/utils/openai-compatible-api'
import { resolveCanonicalModel, getCanonicalIndexBundleForTest } from '../src/reasoning/canonical-model'
import type { PluginLogger } from '../src/plugin/logger'
import type { ToastNotifier } from '../src/ui/toast-notifier'

const discoverSpy = vi.hoisted(() => vi.fn())
vi.mock('../src/utils/openai-compatible-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/openai-compatible-api')>()
  return {
    ...actual,
    discoverModelsFromProvider: (...args: unknown[]) => discoverSpy(...args),
  }
})

const logger: PluginLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
}
const toastNotifier = { error: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) } as unknown as ToastNotifier
const client = {
  config: {
    providers: vi.fn(),
  },
}

function relayProvider(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    npm: '@ai-sdk/openai-compatible',
    options: {
      baseURL: 'https://relay.example.com/v1',
      apiKey: 'sk-explicit',
      modelsDiscovery: { enabled: true },
      ...overrides,
    },
  }
}

beforeEach(() => {
  discoverSpy.mockReset()
  discoverSpy.mockResolvedValue({ ok: false, models: [] })
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Gate 1: Zen/Go no-op plan (v3 §7.5)', () => {
  it('classifies official npm adapter and exact official origins as no-contribution', () => {
    expect(classifyProviderPlan({ npm: '@ai-sdk/opencode' })).toEqual({ kind: 'no-contribution', reason: 'delegated-to-host' })
    expect(classifyProviderPlan({ options: { baseURL: 'https://opencode.ai/zen/v1' } })).toEqual({ kind: 'no-contribution', reason: 'delegated-to-host' })
    expect(classifyProviderPlan({ options: { baseURL: 'https://api.opencode.ai/v1' } })).toEqual({ kind: 'no-contribution', reason: 'delegated-to-host' })
  })

  it('keeps custom gateways and non-official shapes on the discoverable path', () => {
    expect(classifyProviderPlan({ npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://relay.example.com/v1' } }).kind).toBe('discoverable')
    // plaintext origin is never treated as official
    expect(classifyProviderPlan({ options: { baseURL: 'http://opencode.ai/v1' } }).kind).toBe('discoverable')
    // lookalike host must not match exact origin list
    expect(classifyProviderPlan({ options: { baseURL: 'https://opencode.ai.evil.example/v1' } }).kind).toBe('discoverable')
    expect(classifyProviderPlan(null).kind).toBe('discoverable')
    expect(classifyProviderPlan(undefined).kind).toBe('discoverable')
  })

  it('contributes nothing for Zen/Go: zero network, config deep-equal', async () => {
    const zen = {
      npm: '@ai-sdk/opencode',
      options: { baseURL: 'https://api.opencode.ai/v1', apiKey: 'sk-zen', modelsDiscovery: { enabled: true } },
    }
    const before = JSON.parse(JSON.stringify(zen))
    const config = { provider: { zen } }

    await enhanceConfig(config, client as any, toastNotifier, {}, logger)

    expect(JSON.parse(JSON.stringify(zen))).toEqual(before)
    expect(discoverSpy).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      'Provider delegated to host catalog; plugin contributes nothing',
      { provider: 'zen', reason: 'delegated-to-host' },
    )
  })
})

describe('Gate 1: no host SDK re-entry + local credential chain', () => {
  it('never calls client.config.providers()', async () => {
    const config = { provider: { relay: relayProvider() } }
    await enhanceConfig(config, client as any, toastNotifier, {}, logger)
    expect(client.config.providers).not.toHaveBeenCalled()
  })

  it('resolves the key from OPENCODE_AUTH_CONTENT when options.apiKey is absent', async () => {
    vi.stubEnv('OPENCODE_AUTH_CONTENT', JSON.stringify({ relay: { type: 'api', key: 'sk-from-auth' } }))
    const config = { provider: { relay: relayProvider({ apiKey: undefined }) } }
    await enhanceConfig(config, client as any, toastNotifier, {}, logger)
    expect(discoverSpy).toHaveBeenCalledTimes(1)
    expect(discoverSpy.mock.calls[0]![1]).toBe('sk-from-auth')
  })

  it('prefers explicit options.apiKey over the auth store', async () => {
    vi.stubEnv('OPENCODE_AUTH_CONTENT', JSON.stringify({ relay: { type: 'api', key: 'sk-from-auth' } }))
    const config = { provider: { relay: relayProvider({ apiKey: 'sk-explicit' }) } }
    await enhanceConfig(config, client as any, toastNotifier, {}, logger)
    expect(discoverSpy.mock.calls[0]![1]).toBe('sk-explicit')
  })
})

describe('Gate 1: deadline abort blocks late config mutation (v3 §3.1)', () => {
  it('does no network and leaves config untouched when the signal is already aborted', async () => {
    const relay = relayProvider()
    const before = JSON.parse(JSON.stringify(relay))
    const config = { provider: { relay } }
    const controller = new AbortController()
    controller.abort()

    await enhanceConfig(config, client as any, toastNotifier, {}, logger, { signal: controller.signal })

    expect(discoverSpy).not.toHaveBeenCalled()
    expect(JSON.parse(JSON.stringify(relay))).toEqual(before)
  })

  it('discovers normally without a signal (regression guard for legacy path)', async () => {
    discoverSpy.mockResolvedValue({ ok: true, models: [{ id: 'm1' }] })
    const config = { provider: { relay: relayProvider() } }
    await enhanceConfig(config, client as any, toastNotifier, {}, logger)
    expect((config.provider.relay.models as Record<string, unknown>).m1).toBeDefined()
  })

  it('a result arriving after abort is not published to config', async () => {
    let releaseDiscovery!: (value: { ok: boolean; models: Array<{ id: string }> }) => void
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve
    })
    discoverSpy.mockImplementation(() => new Promise((resolve) => {
      releaseDiscovery = resolve
      notifyStarted()
    }))

    const relay = relayProvider()
    const before = JSON.parse(JSON.stringify(relay))
    const config = { provider: { relay } }
    const controller = new AbortController()

    const pending = enhanceConfig(config, client as any, toastNotifier, {}, logger, { signal: controller.signal })
    await started
    controller.abort()
    releaseDiscovery({ ok: false, models: [] })
    await pending

    expect(JSON.parse(JSON.stringify(relay))).toEqual(before)
  })
})

describe('Gate 1: pre-built canonical indexes (v3 Gate 1)', () => {
  const index = new Map<string, { id: string; reasoning_options?: string[] }>([
    ['openai/gpt-5', { id: 'openai/gpt-5', reasoning_options: ['low', 'high'] }],
    ['deepseek/deepseek-v4-flash', { id: 'deepseek/deepseek-v4-flash' }],
    ['deepseek/deepseek-v4-flash-0731', { id: 'deepseek/deepseek-v4-flash-0731' }],
    ['google/gemini-3-pro', { id: 'google/gemini-3-pro', reasoning_options: ['low', 'high'] }],
  ])

  it('resolves identically across repeated calls on the same index', () => {
    const first = resolveCanonicalModel({ modelId: 'gpt-5', modelsDevIndex: index })
    const second = resolveCanonicalModel({ modelId: 'gpt-5', modelsDevIndex: index })
    expect(second).toEqual(first)
    expect(first.canonicalModelId).toBe('openai/gpt-5')
    expect(first.source).toBe('unique-model-id')
  })

  it('resolves a dated id exactly (suffix -0731 is not a safe revision marker)', () => {
    const res = resolveCanonicalModel({ modelId: 'deepseek-v4-flash-0731', modelsDevIndex: index })
    expect(res.canonicalModelId).toBe('deepseek/deepseek-v4-flash-0731')
    expect(res.source).toBe('unique-model-id')
  })

  it('applies the strict date-suffix rule only for real revision markers', () => {
    const indexWithBase = new Map([...index])
    const res = resolveCanonicalModel({ modelId: 'deepseek-v4-flash-2026-01-15', modelsDevIndex: indexWithBase })
    expect(res.canonicalModelId).toBe('deepseek/deepseek-v4-flash')
    expect(res.source).toBe('safe-revision-match')
    expect(res.confidence).toBe('high')
  })

  it('exposes the memoized bundle for O(1) reuse on the same index instance', () => {
    const bundleA = getCanonicalIndexBundleForTest(index)
    const bundleB = getCanonicalIndexBundleForTest(index)
    expect(bundleB).toBe(bundleA)
    expect(bundleA.lowerIndex.get('openai/gpt-5')?.id).toBe('openai/gpt-5')
  })
})

describe('Gate 1: HTTP layer consumes AbortSignal', () => {
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    server = createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'slow-model' }] }))
      }, 500)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}/v1`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('fails fast on a pre-aborted signal without publishing models', async () => {
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    const result = await discoverModelsFromProvider(baseUrl, 'sk-test', '/models', 5000, controller.signal)
    expect(result.ok).toBe(false)
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('aborts an in-flight slow response and returns a failure', async () => {
    const controller = new AbortController()
    const pending = discoverModelsFromProvider(baseUrl, 'sk-test', '/models', 10000, controller.signal)
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    expect(result.ok).toBe(false)
  })
})
