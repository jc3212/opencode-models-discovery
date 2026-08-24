import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { DiscoveryCoordinator } from '../src/discovery/coordinator'
import {
  PromiseDiscoveryRuntime,
  type ResolvedIdentityContext,
} from '../src/entrypoints/promise-runtime'
import { createConsumerKey, createHostInstanceToken } from '../src/discovery/identity'
import { resolveV1Whitelist } from '../src/discovery/visibility/v1-whitelist'
import type { InventoryFetchResult } from '../src/discovery/adapters/shared'

function route(key: string) {
  return { selectionKey: key, invocationId: key, routeKind: 'model-name' as const, readiness: 'ready' as const, maturity: 'stable' as const }
}

const CONSUMER = createConsumerKey(createHostInstanceToken(), 'v2-promise', 'relay')

describe('coordinator userWhitelist passthrough', () => {
  it('intersects complete-inventory auto routes with the whitelist', () => {
    const coordinator = new DiscoveryCoordinator({
      consumer: CONSUMER,
      semantics: 'observed',
      contribution: 'auto',
      userWhitelist: ['m2'],
    })
    coordinator.observeIdentity({ semanticIdentityHash: 'a'.repeat(64), credentialGenerationHash: 'b'.repeat(64) })
    const token = coordinator.beginRefresh('manual')
    if (!token) throw new Error('expected token')
    const result = coordinator.completeRefresh({ token, kind: 'complete', routes: [route('m1'), route('m2')] })
    expect(result.applied).toBe(true)
    expect(result.snapshot.projection.autoRoutes.map((r) => r.selectionKey)).toEqual(['m2'])
    // Whitelisted-out keys are NOT removed as plugin-owned: they never belonged.
    expect(result.snapshot.projection.removedPluginSelectionKeys).toEqual([])
  })

  it('keeps explicit keys visible even when the whitelist excludes them', () => {
    const coordinator = new DiscoveryCoordinator({
      consumer: CONSUMER,
      semantics: 'observed',
      contribution: 'auto',
      explicitSelectionKeys: ['explicit-1'],
      userWhitelist: ['nothing-matches'],
    })
    coordinator.observeIdentity({ semanticIdentityHash: 'a'.repeat(64), credentialGenerationHash: 'b'.repeat(64) })
    const token = coordinator.beginRefresh('manual')
    if (!token) throw new Error('expected token')
    const result = coordinator.completeRefresh({ token, kind: 'complete', routes: [route('m1')] })
    expect(result.snapshot.projection.visibleSelectionKeys).toEqual(['explicit-1'])
    expect(result.snapshot.projection.state).toBe('explicit-only')
  })
})

describe('runtime userWhitelist end-to-end', () => {
  const tempRoots: string[] = []

  afterAll(async () => {
    await Promise.all(
      tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
    )
  })

  it('flows the resolved V1 whitelist through to the published projection', async () => {
    const outer = await mkdtemp(path.join(tmpdir(), 'omd-whitelist-flow-'))
    tempRoots.push(outer)
    const cacheRoot = path.join(outer, 'data')
    const context: ResolvedIdentityContext = {
      identity: {
        providerId: 'relay',
        adapterId: 'generic-openai',
        adapterVersion: 1,
        canonicalRequestUrlRedacted: 'https://relay.example.com/v1/models',
        visibilitySemantics: 'credential-observed',
        visibilityScope: 'credential',
        runtimeAuth: { kind: 'credential', credentialType: 'bearer', identityKind: 'material', identityFingerprint: 'aa'.repeat(32) },
        requestVaryFingerprint: 'bb'.repeat(32),
        apiSurface: 'chat-completions',
      },
      credentialGenerationHash: 'c'.repeat(64),
    }
    const resolution = resolveV1Whitelist({
      models: [
        { selectionKey: 'm1', effectiveRemoteApiId: 'm1' },
        { selectionKey: 'm2', effectiveRemoteApiId: 'm2' },
      ],
      userWhitelist: ['m2'],
    })

    const fetchImpl = async (): Promise<InventoryFetchResult> => ({
      kind: 'complete',
      routes: [route('m1'), route('m2')],
      reason: 'ok',
      authTombstoneEligible: false,
      enumerationUnsupported: false,
    })
    const runtime = new PromiseDiscoveryRuntime({
      cacheRoot,
      secret: Uint8Array.from({ length: 32 }, (_, i) => i + 1),
      consumer: CONSUMER,
      semantics: 'observed',
      contribution: 'auto',
      userWhitelist: resolution.selectionKeyWhitelist,
      resolveIdentity: () => context,
      fetchInventory: fetchImpl,
      freshSeconds: 1000,
      hardStaleSeconds: 4000,
      startupGraceMs: 0,
      nowMs: () => 1_700_000_000_000,
    })
    await runtime.initialize()
    runtime.markSetupReturned(1_700_000_000_000)
    const begin = runtime.beginRefresh('post-setup')
    if (!begin.started) throw new Error(`expected start: ${JSON.stringify(begin)}`)
    const summary = await runtime.runActiveRefresh(begin.token)
    expect(summary.completion?.applied).toBe(true)
    expect(runtime.snapshot().projection.visibleSelectionKeys).toEqual(['m2'])
  })
})
