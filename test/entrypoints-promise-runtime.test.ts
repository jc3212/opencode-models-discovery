import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  PromiseDiscoveryRuntime,
  type ResolvedIdentityContext,
} from '../src/entrypoints/promise-runtime'
import { createConsumerKey, createHostInstanceToken } from '../src/discovery/identity'
import type { InventoryFetchResult } from '../src/discovery/adapters/shared'
import { EvidenceLedger } from '../src/discovery/evidence/ledger'
import { computeSemanticIdentityHash } from '../src/discovery/identity'
import { applyRefreshCompletion } from '../src/discovery/refresh-persistence'
import { hasAuthTombstone } from '../src/cache/tombstone-store'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from '../src/discovery/types'

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const GEN = 'c'.repeat(64)
const BASE_CLOCK = 1_700_000_000_000
const FRESH_SECONDS = 1000
const HARD_STALE_SECONDS = 4000

const tempRoots: string[] = []

async function makeCacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-promise-runtime-'))
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

function result(partial: Partial<InventoryFetchResult>): InventoryFetchResult {
  return {
    kind: 'complete',
    routes: [],
    reason: 'ok',
    authTombstoneEligible: false,
    enumerationUnsupported: false,
    ...partial,
  }
}

interface Fixture {
  runtime: PromiseDiscoveryRuntime
  cacheRoot: string
  context: ResolvedIdentityContext
}

function makeRuntime(options: {
  cacheRoot: string
  clock: () => number
  fetch: (context: ResolvedIdentityContext) => Promise<InventoryFetchResult>
  evidenceLedger?: EvidenceLedger
}): PromiseDiscoveryRuntime {
  const id = identity()
  const context: ResolvedIdentityContext = { identity: id, credentialGenerationHash: GEN }
  return new PromiseDiscoveryRuntime({
    cacheRoot: options.cacheRoot,
    secret: SECRET,
    consumer: createConsumerKey(createHostInstanceToken(), 'v2-promise', 'relay'),
    semantics: 'observed',
    contribution: 'auto',
    resolveIdentity: () => context,
    fetchInventory: options.fetch,
    freshSeconds: FRESH_SECONDS,
    hardStaleSeconds: HARD_STALE_SECONDS,
    startupGraceMs: 50,
    nowMs: options.clock,
    ...(options.evidenceLedger ? { evidenceLedger: options.evidenceLedger } : {}),
    ...(options.evidenceLedger
      ? { evidenceSource: { adapterId: 'generic-openai', endpoint: '/v1/models' } }
      : {}),
  })
}

async function seedComplete(
  cacheRoot: string,
  receivedAtMs: number,
  keys: string[],
): Promise<void> {
  await applyRefreshCompletion({
    cacheRoot,
    secret: SECRET,
    identity: identity(),
    credentialGenerationHash: GEN,
    kind: 'complete',
    routes: keys.map(route),
    receivedAt: new Date(receivedAtMs).toISOString(),
  })
}

describe('PromiseDiscoveryRuntime', () => {
  it('applies a fresh LKG at startup and reports the phase', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    await seedComplete(cacheRoot, clock - 100_000, ['m1', 'm2'])
    const runtime = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })

    const outcome = await runtime.initialize()
    expect(outcome).toEqual({ appliedLkg: true, reason: 'lkg-applied-fresh' })
    expect(runtime.snapshot().projection.state).toBe('fresh')
    expect(runtime.snapshot().projection.visibleSelectionKeys).toEqual(['m1', 'm2'])
  })

  it('keeps the LKG dormant behind a standing tombstone', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    await seedComplete(cacheRoot, clock - 100_000, ['m1'])
    await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: identity(),
      credentialGenerationHash: GEN,
      kind: 'auth-failure',
      confirmedIdentityAuthFailure: true,
      receivedAt: new Date(clock).toISOString(),
    })
    const runtime = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })

    const outcome = await runtime.initialize()
    expect(outcome).toEqual({ appliedLkg: false, reason: 'startup-auth-blocked' })
    expect(runtime.snapshot().projection.state).toBe('explicit-only')
  })

  it('refuses a hard-stale LKG instead of resurrecting it', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    await seedComplete(cacheRoot, clock - HARD_STALE_SECONDS * 1000 * 2, ['m1'])
    const runtime = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })

    const outcome = await runtime.initialize()
    expect(outcome).toEqual({ appliedLkg: false, reason: 'lkg-hard-stale-not-applied' })
  })

  it('gates the post-setup trigger on the startup barrier', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    const runtime = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })
    await runtime.initialize()
    runtime.markSetupReturned(clock)

    const early = runtime.beginRefresh('post-setup')
    expect(early).toEqual({ started: false, reason: 'startup-barrier' })

    clock += 100
    const late = runtime.beginRefresh('post-setup')
    expect(late.started).toBe(true)
  })

  it('runs a soft-due refresh end-to-end with persistence and evidence', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    await seedComplete(cacheRoot, clock - 100_000, ['m1'])
    const ledger = new EvidenceLedger()
    const runtime = makeRuntime({
      cacheRoot,
      clock: () => clock,
      fetch: async () => result({ routes: [route('m3')] }),
      evidenceLedger: ledger,
    })
    await runtime.initialize()

    clock += FRESH_SECONDS * 1000 * 1.5
    const begin = runtime.maybeBeginTtlRefresh()
    if (!begin.started) throw new Error(`expected start, got ${begin.reason}`)
    const summary = await runtime.runActiveRefresh(begin.token)

    expect(summary.status).toBe('completed')
    expect(summary.completion?.applied).toBe(true)
    expect(summary.persistence?.action).toBe('save-inventory')
    expect(summary.recordedEvidence).toBe(1)
    expect(runtime.snapshot().projection.visibleSelectionKeys).toEqual(['m3'])

    const semanticHash = computeSemanticIdentityHash(SECRET, identity())
    const evidence = ledger.query({ inventoryIdentityHash: semanticHash })
    expect(evidence).toHaveLength(1)
    expect(evidence[0].completeness).toBe('exhaustive')
    expect(evidence[0].claim).toBe('credential-visible')

    // Fresh again right after a complete refresh.
    expect(runtime.maybeBeginTtlRefresh()).toEqual({ started: false, reason: 'phase-fresh' })
  })

  it('writes a tombstone only for an eligible identity auth failure', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    const semanticHash = computeSemanticIdentityHash(SECRET, identity())
    const runtime = makeRuntime({
      cacheRoot,
      clock: () => clock,
      fetch: async () => result({ kind: 'auth-failure', reason: 'http-401', authTombstoneEligible: true }),
    })
    await runtime.initialize()
    runtime.markSetupReturned(BASE_CLOCK - 1000)
    const begin = runtime.beginRefresh('post-setup')
    if (!begin.started) throw new Error('expected start')
    const summary = await runtime.runActiveRefresh(begin.token)

    expect(summary.completion?.snapshot.state.projection).toBe('auth-blocked')
    expect(summary.persistence?.action).toBe('write-tombstone')
    expect(await hasAuthTombstone(cacheRoot, SECRET, semanticHash, GEN)).toBeDefined()

    // A later startup must stay blocked for this exact pair.
    const next = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })
    expect(await next.initialize()).toEqual({ appliedLkg: false, reason: 'startup-auth-blocked' })
  })

  it('persists nothing for an unconfirmed enumeration-only auth failure', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    const semanticHash = computeSemanticIdentityHash(SECRET, identity())
    const runtime = makeRuntime({
      cacheRoot,
      clock: () => clock,
      fetch: async () => result({
        kind: 'auth-failure',
        reason: 'enumeration-403',
        enumerationUnsupported: true,
      }),
    })
    await runtime.initialize()
    runtime.markSetupReturned(BASE_CLOCK - 1000)
    const begin = runtime.beginRefresh('post-setup')
    if (!begin.started) throw new Error('expected start')
    const summary = await runtime.runActiveRefresh(begin.token)

    expect(summary.completion?.snapshot.state.projection).toBe('explicit-only')
    expect(await hasAuthTombstone(cacheRoot, SECRET, semanticHash, GEN)).toBeUndefined()
  })

  it('degrades transport exceptions to transient failures without store writes', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    const runtime = makeRuntime({
      cacheRoot,
      clock: () => clock,
      fetch: async () => {
        throw new Error('socket hang up')
      },
    })
    await runtime.initialize()
    runtime.markSetupReturned(BASE_CLOCK - 1000)
    const begin = runtime.beginRefresh('post-setup')
    if (!begin.started) throw new Error('expected start')
    const summary = await runtime.runActiveRefresh(begin.token)

    expect(summary.persistence?.action).toBe('no-op')
    expect(runtime.snapshot().state.refresh).toBe('backoff')
  })

  it('skips runs for tokens that are no longer active', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    const runtime = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })
    await runtime.initialize()
    runtime.markSetupReturned(BASE_CLOCK - 1000)
    const begin = runtime.beginRefresh('post-setup')
    if (!begin.started) throw new Error('expected start')
    await runtime.runActiveRefresh(begin.token)
    const replay = await runtime.runActiveRefresh(begin.token)
    expect(replay).toEqual({ status: 'skipped', reason: 'stale-token' })
  })

  it('reports a declined TTL start before any completion ever happened', async () => {
    const cacheRoot = await makeCacheRoot()
    let clock = BASE_CLOCK
    const runtime = makeRuntime({ cacheRoot, clock: () => clock, fetch: async () => result({}) })
    await runtime.initialize()
    expect(runtime.maybeBeginTtlRefresh()).toEqual({ started: false, reason: 'phase-never-completed' })
  })
})
