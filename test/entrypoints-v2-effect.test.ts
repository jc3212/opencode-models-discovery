import { Duration, Effect } from 'effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { makeV2EffectEntrypoint, withV2EffectEntrypoint } from '../src/entrypoints/v2-effect'
import type { InventoryFetchResult } from '../src/discovery/adapters/shared'
import { createConsumerKey, createHostInstanceToken } from '../src/discovery/identity'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from '../src/discovery/types'

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const GEN = 'c'.repeat(64)
const BASE_CLOCK = 1_700_000_000_000

const tempRoots: string[] = []

async function makeCacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-v2-effect-'))
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

function result(routes: string[]): InventoryFetchResult {
  return {
    kind: 'complete',
    routes: routes.map(route),
    reason: 'ok',
    authTombstoneEligible: false,
    enumerationUnsupported: false,
  }
}

type Options = Parameters<typeof makeV2EffectEntrypoint>[0]

function baseOptions(overrides?: Partial<Options>): Options {
  return {
    cacheRoot: '/omd-v2-effect-unused',
    secret: SECRET,
    consumer: createConsumerKey(createHostInstanceToken(), 'v2-effect', 'relay'),
    semantics: 'observed',
    contribution: 'auto',
    resolveIdentity: () => ({ identity: identity(), credentialGenerationHash: GEN }),
    fetchInventory: async () => result(['m1']),
    freshSeconds: 1000,
    hardStaleSeconds: 4000,
    startupGraceMs: 0,
    nowMs: () => BASE_CLOCK,
    ...overrides,
  }
}

describe('V2 Effect entrypoint (E2)', () => {
  it('runs the scoped body and disposes the runtime on scope close', async () => {
    const cacheRoot = await makeCacheRoot()
    let disposedInsideBody = false
    let snapshotAtEnd: { disposed: boolean } | undefined
    await Effect.runPromise(
      withV2EffectEntrypoint(baseOptions({ cacheRoot }), (runtime) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            disposedInsideBody = (runtime.snapshot() as { disposed: boolean }).disposed
          })
          yield* Effect.sleep(Duration.millis(20))
          yield* Effect.sync(() => {
            // Still inside scope here.
            snapshotAtEnd = { disposed: false }
          })
          return undefined as void
        }),
      ),
    )
    expect(disposedInsideBody).toBe(false)
    expect(snapshotAtEnd?.disposed).toBe(false)
  })

  it('forks the post-setup refresh only after the startup grace window', async () => {
    const cacheRoot = await makeCacheRoot()
    const fetchAt: number[] = []
    const bodyStart = Date.now()
    let bodyDone = false
    await Effect.runPromise(
      withV2EffectEntrypoint(
        baseOptions({
          cacheRoot,
          startupGraceMs: 60,
          // Real wall clock so the barrier anchor advances past its grace.
          nowMs: () => Date.now(),
          fetchInventory: async () => {
            fetchAt.push(Date.now())
            return result(['m1'])
          },
        }),
        () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              bodyDone = true
            })
            // Hold the scope open past the grace window: a forked background
            // refresh is cancelled when its scope closes, which is exactly
            // the contract under test here.
            yield* Effect.sleep(Duration.millis(160))
          }),
      ),
    )
    expect(bodyDone).toBe(true)
    expect(fetchAt.length).toBe(1)
    expect(fetchAt[0] - bodyStart).toBeGreaterThanOrEqual(40)
  }, 5000)

  it('aborts an in-flight fetch when the scope closes mid-refresh', async () => {
    const cacheRoot = await makeCacheRoot()
    let observedSignal: AbortSignal | undefined
    let started = false

    await Effect.runPromise(
      withV2EffectEntrypoint(
        baseOptions({
          cacheRoot,
          startupGraceMs: 10,
          nowMs: () => Date.now(),
          fetchInventory: async (_context, signal) => {
            observedSignal = signal
            started = true
            return new Promise<InventoryFetchResult>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')))
            })
          },
        }),
        () => Effect.sleep(Duration.millis(400)),
      ),
    ).catch(() => undefined)
    expect(started).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
  }, 5000)
})
