import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { V2PromiseEntrypoint, type V2PromiseOptions } from '../src/entrypoints/v2-promise'
import type { InventoryFetchResult } from '../src/discovery/adapters/shared'
import { applyRefreshCompletion } from '../src/discovery/refresh-persistence'
import { createConsumerKey, createHostInstanceToken } from '../src/discovery/identity'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from '../src/discovery/types'

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const GEN = 'c'.repeat(64)
const BASE_CLOCK = 1_700_000_000_000

const tempRoots: string[] = []

async function makeCacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-v2-promise-'))
  tempRoots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
})

function identity(): SemanticInventoryIdentityV3 {
  return {
    providerId: 'relay',
    adapterId: 'generic-openai',
    adapterVersion: 1,
    canonicalRequestUrlRedacted: 'https://relay.example.com/v1/models',
    visibilitySemantics: 'credential-observed',
    visibilityScope: 'credential',
    runtimeAuth: {
      kind: 'credential',
      credentialType: 'bearer',
      identityKind: 'material',
      identityFingerprint: 'aa'.repeat(32),
    },
    requestVaryFingerprint: 'bb'.repeat(32),
    apiSurface: 'chat-completions',
  }
}

function route(key: string): DiscoveredRoute {
  return {
    selectionKey: key,
    invocationId: key,
    routeKind: 'model-name',
    readiness: 'ready',
    maturity: 'stable',
  }
}

interface Fixture {
  entrypoint: V2PromiseEntrypoint
  cacheRoot: string
  fetchCalls: { count: number }
}

async function makeEntrypoint(options: {
  cacheRoot: string
  clock?: () => number
  fetch?: (calls: { count: number }) => Promise<InventoryFetchResult>
}): Promise<Fixture> {
  const fetchCalls = { count: 0 }
  const id = identity()
  const config: V2PromiseOptions = {
    cacheRoot: options.cacheRoot,
    secret: SECRET,
    consumer: createConsumerKey(createHostInstanceToken(), 'v2-promise', 'relay'),
    semantics: 'observed',
    contribution: 'auto',
    resolveIdentity: () => ({ identity: id, credentialGenerationHash: GEN }),
    fetchInventory: async (context) =>
      options.fetch
        ? options.fetch(fetchCalls)
        : (
            {
              kind: 'complete',
              routes: context.identity.providerId === 'never' ? [] : [route('m1')],
              reason: 'ok',
              authTombstoneEligible: false,
              enumerationUnsupported: false,
            }
          ),
    freshSeconds: 1000,
    hardStaleSeconds: 4000,
    startupGraceMs: 0,
    nowMs: options.clock ?? (() => BASE_CLOCK),
  }
  const entrypoint = new V2PromiseEntrypoint(config)
  return { entrypoint, cacheRoot: options.cacheRoot, fetchCalls }
}

describe('V2PromiseEntrypoint (E1 local-only)', () => {
  let timerSpies: Array<ReturnType<typeof vi.spyOn>>

  beforeEach(() => {
    timerSpies = (['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'] as const).map(
      (name) => vi.spyOn(globalThis, name as never).mockImplementation(() => {
        throw new Error(`background resource created: ${String(name)}`)
      }),
    )
  })

  afterEach(() => {
    for (const spy of timerSpies) spy.mockRestore()
  })

  it('initializes from cache without network or background resources', async () => {
    const cacheRoot = await makeCacheRoot()
    await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: identity(),
      credentialGenerationHash: GEN,
      kind: 'complete',
      routes: [route('m1'), route('m2')],
      receivedAt: new Date(BASE_CLOCK - 100_000).toISOString(),
    })
    const fixture = await makeEntrypoint({ cacheRoot })

    const outcome = await fixture.entrypoint.initialize()
    expect(outcome).toEqual({ appliedLkg: true, reason: 'lkg-applied-fresh' })
    expect(fixture.entrypoint.snapshot().projection.visibleSelectionKeys).toEqual(['m1', 'm2'])
    expect(fixture.fetchCalls.count).toBe(0)
    fixture.entrypoint.dispose()
  })

  it('fetches only inside explicit refreshNow and persists the result', async () => {
    const cacheRoot = await makeCacheRoot()
    const fixture = await makeEntrypoint({
      cacheRoot,
      fetch: (calls) => {
        calls.count += 1
        return {
          kind: 'complete',
          routes: [route('m9')],
          reason: 'ok',
          authTombstoneEligible: false,
          enumerationUnsupported: false,
        }
      },
    })
    await fixture.entrypoint.initialize()

    const summary = await fixture.entrypoint.refreshNow()
    expect(summary.status).toBe('completed')
    expect(summary.completion?.applied).toBe(true)
    expect(fixture.entrypoint.snapshot().projection.visibleSelectionKeys).toEqual(['m9'])

    // Concurrent calls are singleflight-declined with no extra fetch.
    let releaseFetch!: () => void
    const gate = new Promise<void>((resolve) => { releaseFetch = resolve })
    const fixture2 = await makeEntrypoint({
      cacheRoot,
      fetch: (calls) => {
        calls.count += 1
        return gate.then(() => ({
          kind: 'complete' as const,
          routes: [route('m9')],
          reason: 'ok',
          authTombstoneEligible: false,
          enumerationUnsupported: false,
        }))
      },
    })
    await fixture2.entrypoint.initialize()
    const first = fixture2.entrypoint.refreshNow()
    const concurrent = await fixture2.entrypoint.refreshNow()
    expect(concurrent.status).toBe('skipped')
    expect(concurrent.reason).toBe('refresh-declined:coordinator-declined')
    releaseFetch()
    expect((await first).status).toBe('completed')
    expect(fixture2.fetchCalls.count).toBe(1)

    // Sequential explicit refreshes are independent by design.
    await fixture.entrypoint.refreshNow()
    expect(fixture.fetchCalls.count).toBe(2)

    const state = await import('../src/discovery/refresh-persistence').then((m) =>
      m.loadStartupCacheState({
        cacheRoot,
        secret: SECRET,
        identity: identity(),
        credentialGenerationHash: GEN,
      }),
    )
    expect(state.lkg?.routes.map((r) => r.selectionKey)).toEqual(['m9'])
    fixture.entrypoint.dispose()
  })

  it('exposes schedule phase as diagnostics only', async () => {
    const cacheRoot = await makeCacheRoot()
    const fixture = await makeEntrypoint({ cacheRoot })
    await fixture.entrypoint.initialize()
    expect(fixture.entrypoint.schedulePhase()).toBe('never-completed')
    await fixture.entrypoint.refreshNow()
    expect(fixture.entrypoint.schedulePhase()).toBe('fresh')
    fixture.entrypoint.dispose()
  })

  it('declines refresh after dispose and leaves no timers behind', async () => {
    const cacheRoot = await makeCacheRoot()
    const fixture = await makeEntrypoint({ cacheRoot })
    await fixture.entrypoint.initialize()
    fixture.entrypoint.dispose()

    const declined = await fixture.entrypoint.refreshNow()
    expect(declined.status).toBe('skipped')
    expect(declined.reason).toBe('refresh-declined:disposed')

    // Zero-background proof is carried by the beforeEach timer spies: any
    // setTimeout/setInterval/setImmediate/queueMicrotask call by this module
    // would have thrown and failed the test.
    expect(timerSpies.every((spy) => spy.mockRestore !== undefined)).toBe(true)
  })
})
