import { describe, expect, it } from 'vitest'
import {
  classifyInventoryHttpStatus,
  detectBusinessErrorBody,
  parseModelListEnvelope,
  routesFromEntries,
} from '../src/discovery/adapters/shared'
import {
  GENERIC_OPENAI_ADAPTER_ID,
  fetchGenericOpenAIInventory,
  genericOpenAIInventoryContract,
  type GenericOpenAIAdapterConfig,
} from '../src/discovery/adapters/generic-openai'
import {
  OPENROUTER_ADAPTER_ID,
  fetchOpenRouterUserInventory,
  isOpenRouterOfficialOrigin,
  type OpenRouterAdapterConfig,
} from '../src/discovery/adapters/openrouter'
import type { FetchLike } from '../src/discovery/http-client'

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
}

interface FetchRoute {
  match: (url: string) => boolean
  respond: (call: RecordedCall) => Response
}

function makeFetch(routes: FetchRoute[], calls: RecordedCall[] = []): FetchLike {
  return async (url, init) => {
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers: { ...(init?.headers ?? {}) } }
    calls.push(call)
    const route = routes.find((candidate) => candidate.match(url))
    if (!route) throw new Error(`no fake route for ${url}`)
    return route.respond(call)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// ---------------------------------------------------------------------------
// Shared classification primitives (§8.4 result table)
// ---------------------------------------------------------------------------

describe('shared payload validation', () => {
  it('detects gateway business-error bodies as never-complete', () => {
    expect(detectBusinessErrorBody({ success: false, code: 'InvalidApiKey' })).toMatchObject({ code: 'InvalidApiKey' })
    expect(detectBusinessErrorBody({ success: true, data: [] })).toBeUndefined()
    expect(detectBusinessErrorBody({ data: [{ id: 'm1' }] })).toBeUndefined()
    expect(detectBusinessErrorBody('nope')).toBeUndefined()
  })

  it('accepts both list envelopes and counts malformed entries', () => {
    const wrapped = parseModelListEnvelope({ data: [{ id: 'a' }, { id: '' }, 'junk'] })
    expect(wrapped?.entries).toHaveLength(1)
    expect(wrapped?.malformedCount).toBe(2)
    const bare = parseModelListEnvelope([{ id: 'x' }])
    expect(bare?.entries).toHaveLength(1)
    expect(parseModelListEnvelope({ nope: true })).toBeUndefined()
    expect(parseModelListEnvelope(null)).toBeUndefined()
    expect(parseModelListEnvelope({ data: [], total_count: 7 })?.totalCount).toBe(7)
  })

  it('maps entries to ready model-name routes with separated keys', () => {
    const routes = routesFromEntries([{ id: 'deepseek-v4' }])
    expect(routes[0]).toMatchObject({
      selectionKey: 'deepseek-v4',
      invocationId: 'deepseek-v4',
      routeKind: 'model-name',
      readiness: 'ready',
    })
  })

  it('classifies statuses per §8.4: 401 tombstone-eligible only on inference surface', () => {
    expect(classifyInventoryHttpStatus(401, 'inference-surface')).toMatchObject({ kind: 'auth-failure', authTombstoneEligible: true })
    expect(classifyInventoryHttpStatus(403, 'inference-surface')).toMatchObject({ kind: 'auth-failure', authTombstoneEligible: false })
    expect(classifyInventoryHttpStatus(403, 'enumeration-only')).toMatchObject({ kind: 'auth-failure', authTombstoneEligible: false, enumerationUnsupported: true })
    expect(classifyInventoryHttpStatus(404, 'enumeration-only')).toMatchObject({ kind: 'transient-failure', enumerationUnsupported: true })
    expect(classifyInventoryHttpStatus(304, 'inference-surface')).toMatchObject({ kind: 'not-modified' })
    expect(classifyInventoryHttpStatus(400, 'inference-surface')).toMatchObject({ kind: 'invalid' })
  })
})

describe('generic openai adapter contract', () => {
  it('stays observed unless the user explicitly declares credential-effective', () => {
    expect(genericOpenAIInventoryContract()).toMatchObject({ strictEligible: false, visibilitySemantics: 'credential-observed' })
    expect(genericOpenAIInventoryContract({ contract: 'credential-effective' })).toMatchObject({ strictEligible: true })
    expect(GENERIC_OPENAI_ADAPTER_ID).toBe('generic-openai')
  })

  function run(config: Partial<GenericOpenAIAdapterConfig>, routes: FetchRoute[], calls: RecordedCall[] = []) {
    return fetchGenericOpenAIInventory(
      { url: 'https://relay.example.com/v1/models', apiKey: 'key-a', ...config },
      makeFetch(routes, calls),
    )
  }

  it('fetches authenticated model lists and separates selection from invocation ids', async () => {
    const calls: RecordedCall[] = []
    const result = await run({}, [
      { match: (url) => url.endsWith('/v1/models'), respond: () => json({ object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] }) },
    ], calls)
    expect(result.kind).toBe('complete')
    expect(result.routes.map((route) => route.selectionKey)).toEqual(['m1', 'm2'])
    expect(calls[0].headers.authorization).toBe('Bearer key-a')
  })

  it('sends whichever key it is given: key A and key B observe their own groups', async () => {
    const groupOf = (key: string) =>
      run({ apiKey: key }, [
        {
          match: () => true,
          respond: (call) => json({ data: call.headers.authorization === 'Bearer key-b' ? [{ id: 'm3' }] : [{ id: 'm1' }, { id: 'm2' }] }),
        },
      ])
    const a = await groupOf('key-a')
    const b = await groupOf('key-b')
    expect(a.routes.map((route) => route.selectionKey)).toEqual(['m1', 'm2'])
    expect(b.routes.map((route) => route.selectionKey)).toEqual(['m3'])
  })

  it('reports same-key group shrink as a complete replacement candidate', async () => {
    const first = await run({}, [{ match: () => true, respond: () => json({ data: [{ id: 'm1' }, { id: 'm2' }] }) }])
    const second = await run({}, [{ match: () => true, respond: () => json({ data: [{ id: 'm2' }] }) }])
    expect(first.kind).toBe('complete')
    expect(second.kind).toBe('complete')
    expect(second.routes.map((route) => route.selectionKey)).toEqual(['m2'])
  })

  it('treats a validated empty list as complete-empty (never fabricated models)', async () => {
    const result = await run({}, [{ match: () => true, respond: () => json({ data: [] }) }])
    expect(result.kind).toBe('complete')
    expect(result.routes).toEqual([])
  })

  it('rejects business-error bodies and schema mismatches as invalid', async () => {
    const business = await run({}, [{ match: () => true, respond: () => json({ success: false, code: 'GroupNotFound' }) }])
    expect(business.kind).toBe('invalid')
    expect(business.reason).toContain('GroupNotFound')
    const badCode = await run({}, [{ match: () => true, respond: () => json({ code: 'InternalError' }) }])
    expect(badCode.kind).toBe('invalid')
    const schema = await run({}, [{ match: () => true, respond: () => json({ unexpected: true }) }])
    expect(schema.kind).toBe('invalid')
    expect(schema.reason).toBe('schema-mismatch')
  })

  it('downgrades malformed payloads to partial instead of complete-empty', async () => {
    const result = await run({}, [{ match: () => true, respond: () => json({ data: [{ id: 'ok' }, { broken: true }] }) }])
    expect(result.kind).toBe('partial')
  })

  it('keeps 401 tombstone-eligible and 403 permission-denied non-tombstone', async () => {
    const unauthorized = await run({}, [{ match: () => true, respond: () => new Response('', { status: 401 }) }])
    expect(unauthorized.kind).toBe('auth-failure')
    expect(unauthorized.authTombstoneEligible).toBe(true)
    const forbidden = await run({}, [{ match: () => true, respond: () => new Response('', { status: 403 }) }])
    expect(forbidden.kind).toBe('auth-failure')
    expect(forbidden.authTombstoneEligible).toBe(false)
  })

  it('classifies transport failures as transient without tombstones', async () => {
    const failing: FetchLike = async () => {
      throw new Error('boom')
    }
    const result = await fetchGenericOpenAIInventory({ url: 'https://relay.example.com/v1/models' }, failing)
    expect(result.kind).toBe('transient-failure')
    expect(result.authTombstoneEligible).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// OpenRouter adapter (§7.1)
// ---------------------------------------------------------------------------

const OR_BASE = 'https://openrouter.ai'

function orConfig(extra: Partial<OpenRouterAdapterConfig> = {}): OpenRouterAdapterConfig {
  return { baseUrl: OR_BASE, apiKey: 'sk-or-inference', ...extra }
}

function userModelsUrl(offset: number, limit: number): string {
  return `${OR_BASE}/api/v1/models/user?offset=${offset}&limit=${limit}`
}

describe('openrouter adapter', () => {
  it('refuses non-official origins before any network activity', async () => {
    const calls: RecordedCall[] = []
    const result = await fetchOpenRouterUserInventory(
      orConfig({ baseUrl: 'https://openrouter.proxy.example.com' }),
      makeFetch([], calls),
    )
    expect(result.kind).toBe('invalid')
    expect(result.reason).toBe('non-official-origin')
    expect(calls).toHaveLength(0)
    expect(isOpenRouterOfficialOrigin(`${OR_BASE}/docs`)).toBe(true)
    expect(isOpenRouterOfficialOrigin('https://evil.example.com')).toBe(false)
  })

  it('refuses to enumerate without an inference credential', async () => {
    const calls: RecordedCall[] = []
    const result = await fetchOpenRouterUserInventory(orConfig({ apiKey: undefined }), makeFetch([], calls))
    expect(result.kind).toBe('invalid')
    expect(result.reason).toBe('credential-unresolved')
    expect(calls).toHaveLength(0)
    expect(OPENROUTER_ADAPTER_ID).toBe('openrouter')
  })

  it('paginates the user-filtered list fully and reports complete', async () => {
    const calls: RecordedCall[] = []
    const pageOne = Array.from({ length: 100 }, (_, index) => ({ id: `model-${index}` }))
    const result = await fetchOpenRouterUserInventory(orConfig(), makeFetch([
      { match: (url) => url.includes('/api/v1/key'), respond: () => json({ data: { label: 'k' } }) },
      { match: (url) => url.includes('offset=0'), respond: () => json({ data: pageOne, total_count: 102 }) },
      { match: (url) => url.includes('offset=100'), respond: () => json({ data: [{ id: 'model-100' }, { id: 'model-101' }], total_count: 102 }) },
    ], calls))
    expect(result.kind).toBe('complete')
    expect(result.routes).toHaveLength(102)
    expect(calls.map((call) => call.url)).toEqual([
      `${OR_BASE}/api/v1/key`,
      userModelsUrl(0, 100),
      userModelsUrl(100, 100),
    ])
  })

  it('never reaches /models/user when the key endpoint rejects the credential', async () => {
    const calls: RecordedCall[] = []
    const result = await fetchOpenRouterUserInventory(orConfig(), makeFetch([
      { match: (url) => url.includes('/api/v1/key'), respond: () => new Response('', { status: 401 }) },
      { match: () => true, respond: () => json({ data: [] }) },
    ], calls))
    expect(result.kind).toBe('auth-failure')
    expect(result.authTombstoneEligible).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it.each([403, 404])('treats enumeration-only %d as unsupported: explicit survive, zero fallback', async (status) => {
    const calls: RecordedCall[] = []
    const result = await fetchOpenRouterUserInventory(orConfig(), makeFetch([
      { match: (url) => url.includes('/api/v1/key'), respond: () => json({ data: { label: 'k' } }) },
      { match: (url) => url.includes('/models/user'), respond: () => new Response('', { status }) },
      { match: (url) => url.endsWith('/api/v1/models'), respond: () => json({ data: [{ id: 'public-model' }] }) },
    ], calls))
    expect(result.enumerationUnsupported).toBe(true)
    expect(result.authTombstoneEligible).toBe(false)
    // No global-catalog fallback may be requested (§7.1).
    expect(calls.some((call) => call.url.endsWith('/api/v1/models'))).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('reports truncated pagination as partial, never complete', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `m-${index}` }))
    const result = await fetchOpenRouterUserInventory(orConfig(), makeFetch([
      { match: (url) => url.includes('/api/v1/key'), respond: () => json({ data: {} }) },
      { match: (url) => url.includes('offset=0'), respond: () => json({ data: page, total_count: 300 }) },
      { match: (url) => url.includes('offset=100'), respond: () => json({ data: page.slice(0, 50), total_count: 300 }) },
    ]))
    expect(result.kind).toBe('partial')
    expect(result.reason).toContain('pagination-truncated')
  })

  it('downgrades pages containing malformed entries to partial', async () => {
    const result = await fetchOpenRouterUserInventory(orConfig(), makeFetch([
      { match: (url) => url.includes('/api/v1/key'), respond: () => json({ data: {} }) },
      { match: (url) => url.includes('offset=0'), respond: () => json({ data: [{ id: 'good' }, null] }) },
    ]))
    expect(result.kind).toBe('partial')
  })
})

// ---------------------------------------------------------------------------
// Coordinator wiring for non-confirmed auth failures
// ---------------------------------------------------------------------------

describe('coordinator auth-failure confirmation flag', () => {
  it('degrades unconfirmed auth failures to explicit-only without blocking LKG', async () => {
    const { DiscoveryCoordinator } = await import('../src/discovery/coordinator')
    const { createHostInstanceToken } = await import('../src/discovery/identity')
    const secret = new Uint8Array(32).fill(7)
    const host = createHostInstanceToken()
    const consumer = { host, backendKind: 'v2-effect' as const, logicalProviderSlot: 'or' }

    const identityHash = 'a'.repeat(64)
    const generationHash = 'b'.repeat(64)

    const coordinator = new DiscoveryCoordinator({
      consumer,
      semantics: 'strict',
      contribution: 'auto',
    })
    coordinator.observeIdentity({ semanticIdentityHash: identityHash, credentialGenerationHash: generationHash })
    const token = coordinator.beginRefresh('manual')!
    expect(token).toBeDefined()

    const result = coordinator.completeRefresh({
      token,
      kind: 'auth-failure',
      confirmedIdentityAuthFailure: false,
    })
    expect(result.applied).toBe(true)
    expect(result.snapshot.state.projection).toBe('explicit-only')

    // Confirmed default still blocks.
    const second = new DiscoveryCoordinator({ consumer, semantics: 'strict', contribution: 'auto' })
    void secret
    second.observeIdentity({ semanticIdentityHash: identityHash, credentialGenerationHash: generationHash })
    const token2 = second.beginRefresh('manual')!
    const blocked = second.completeRefresh({ token: token2, kind: 'auth-failure' })
    expect(blocked.snapshot.state.projection).toBe('auth-blocked')
  })
})
