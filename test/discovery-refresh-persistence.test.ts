import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  applyRefreshCompletion,
  decidePersistence,
  loadStartupCacheState,
} from '../src/discovery/refresh-persistence'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from '../src/discovery/types'

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const GEN = 'c'.repeat(64)

const tempRoots: string[] = []

async function makeCacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-refresh-persistence-'))
  tempRoots.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
})

function identity(fingerprint = 'aa'.repeat(32)): SemanticInventoryIdentityV3 {
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
      identityFingerprint: fingerprint,
    },
    requestVaryFingerprint: 'bb'.repeat(32),
    apiSurface: 'chat-completions',
  }
}

function route(key: string): DiscoveredRoute {
  return { selectionKey: key, invocationId: key, routeKind: 'model-name', readiness: 'ready', maturity: 'stable' }
}

describe('decidePersistence', () => {
  it('maps every completion kind per the frozen matrix', () => {
    expect(decidePersistence({ kind: 'complete' })).toEqual({ action: 'save-inventory', reason: 'complete-lkg' })
    expect(decidePersistence({ kind: 'partial' })).toEqual({ action: 'quarantine', reason: 'partial-never-overwrites-lkg' })
    expect(decidePersistence({ kind: 'invalid' })).toEqual({ action: 'quarantine', reason: 'invalid-schema' })
    expect(decidePersistence({ kind: 'not-modified' })).toEqual({ action: 'no-op', reason: 'not-modified' })
    expect(decidePersistence({ kind: 'transient-failure' })).toEqual({ action: 'no-op', reason: 'transient-backoff-only' })
  })

  it('writes a tombstone only for a confirmed identity auth failure', () => {
    expect(decidePersistence({ kind: 'auth-failure', confirmedIdentityAuthFailure: true }))
      .toEqual({ action: 'write-tombstone', reason: 'confirmed-auth-failure' })
    expect(decidePersistence({ kind: 'auth-failure' }))
      .toEqual({ action: 'write-tombstone', reason: 'confirmed-auth-failure' })
    expect(decidePersistence({ kind: 'auth-failure', confirmedIdentityAuthFailure: false }))
      .toEqual({ action: 'no-op', reason: 'unconfirmed-auth-no-tombstone' })
  })
})

describe('applyRefreshCompletion', () => {
  it('persists a complete listing as the per-identity LKG and loads it back', async () => {
    const cacheRoot = await makeCacheRoot()
    const id = identity()
    const applied = await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
      kind: 'complete',
      routes: [route('m1'), route('m2')],
      receivedAt: '2026-08-24T00:00:00.000Z',
    })
    expect(applied.action).toBe('save-inventory')
    if (applied.action !== 'save-inventory') throw new Error('unreachable')
    expect(applied.routeCount).toBe(2)

    const state = await loadStartupCacheState({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
    })
    expect(state.lkg?.routes.map((r) => r.selectionKey)).toEqual(['m1', 'm2'])
    expect(state.tombstone).toBeUndefined()
  })

  it('persists an authoritative complete-empty as a zero-route complete LKG', async () => {
    const cacheRoot = await makeCacheRoot()
    const id = identity('11'.repeat(32))
    const applied = await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
      kind: 'complete',
      receivedAt: '2026-08-24T00:00:00.000Z',
    })
    expect(applied.action).toBe('save-inventory')
    if (applied.action !== 'save-inventory') throw new Error('unreachable')
    expect(applied.routeCount).toBe(0)

    const state = await loadStartupCacheState({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
    })
    expect(state.lkg?.routes).toEqual([])
  })

  it('quarantines partial results without overwriting an existing LKG', async () => {
    const cacheRoot = await makeCacheRoot()
    const id = identity('22'.repeat(32))
    const base = {
      cacheRoot,
      secret: SECRET as Uint8Array,
      identity: id,
      credentialGenerationHash: GEN,
    }
    await applyRefreshCompletion({
      ...base,
      kind: 'complete',
      routes: [route('m1')],
      receivedAt: '2026-08-24T00:00:00.000Z',
    })
    const applied = await applyRefreshCompletion({
      ...base,
      kind: 'partial',
      quarantineReason: 'pagination-truncated-3-of-9',
      summary: { pages: 3 },
      receivedAt: '2026-08-24T00:01:00.000Z',
    })
    expect(applied.action).toBe('quarantine')
    if (applied.action !== 'quarantine') throw new Error('unreachable')
    expect(applied.pruned).toBe(0)

    const state = await loadStartupCacheState({ ...base })
    expect(state.lkg?.routes.map((r) => r.selectionKey)).toEqual(['m1'])
  })

  it('binds tombstones to the exact credential generation only', async () => {
    const cacheRoot = await makeCacheRoot()
    const id = identity('33'.repeat(32))
    const applied = await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
      kind: 'auth-failure',
      confirmedIdentityAuthFailure: true,
      receivedAt: '2026-08-24T00:02:00.000Z',
    })
    expect(applied.action).toBe('write-tombstone')

    const blocked = await loadStartupCacheState({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
    })
    expect(blocked.tombstone?.reason).toBe('confirmed-auth-failure')

    const rotated = await loadStartupCacheState({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: 'd'.repeat(64),
    })
    expect(rotated.tombstone).toBeUndefined()
  })

  it('persists nothing for unconfirmed auth failures and no-op completions', async () => {
    for (const options of [
      { kind: 'auth-failure' as const, confirmedIdentityAuthFailure: false, credentialGenerationHash: GEN },
      { kind: 'not-modified' as const },
      { kind: 'transient-failure' as const },
    ]) {
      const cacheRoot = await makeCacheRoot()
      const applied = await applyRefreshCompletion({
        cacheRoot,
        secret: SECRET,
        identity: identity('44'.repeat(32)),
        ...options,
      })
      expect(applied).toEqual({ action: 'no-op', reason: expect.any(String) })
      const state = await loadStartupCacheState({
        cacheRoot,
        secret: SECRET,
        identity: identity('44'.repeat(32)),
        credentialGenerationHash: GEN,
      })
      expect(state.lkg).toBeUndefined()
      expect(state.tombstone).toBeUndefined()
    }
  })

  it('rejects complete or confirmed-auth completions without a generation hash', async () => {
    const cacheRoot = await makeCacheRoot()
    const base = {
      cacheRoot,
      secret: SECRET as Uint8Array,
      identity: identity('55'.repeat(32)),
    }
    await expect(applyRefreshCompletion({ ...base, kind: 'complete', routes: [route('m1')] }))
      .rejects.toThrow(TypeError)
    await expect(applyRefreshCompletion({
      ...base,
      kind: 'auth-failure',
      confirmedIdentityAuthFailure: true,
    })).rejects.toThrow(TypeError)
  })

  it('recomputes the identity hash internally instead of trusting callers', async () => {
    const cacheRoot = await makeCacheRoot()
    const id = identity('66'.repeat(32))
    const first = await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
      kind: 'complete',
      routes: [route('m1')],
      receivedAt: '2026-08-24T00:03:00.000Z',
    })
    // A second save of the same identity must land on the same path.
    const second = await applyRefreshCompletion({
      cacheRoot,
      secret: SECRET,
      identity: id,
      credentialGenerationHash: GEN,
      kind: 'complete',
      routes: [route('m1'), route('m2')],
      receivedAt: '2026-08-24T00:04:00.000Z',
    })
    if (first.action !== 'save-inventory' || second.action !== 'save-inventory') {
      throw new Error('unreachable')
    }
    expect(second.path).toBe(first.path)
  })
})
