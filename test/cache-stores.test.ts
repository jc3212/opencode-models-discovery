import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  deleteCompleteInventory,
  loadCompleteInventory,
  sanitizeRoutes,
  saveCompleteInventory,
} from '../src/cache/inventory-store'
import {
  clearAuthTombstone,
  hasAuthTombstone,
  writeAuthTombstone,
} from '../src/cache/tombstone-store'
import { appendQuarantineEntry } from '../src/cache/quarantine-store'
import {
  CacheFileError,
  assertFullHashName,
  assertTimestampedHashName,
  writeJsonAtomic,
} from '../src/cache/safe-file'
import type { DiscoveredRoute, SemanticInventoryIdentityV3 } from '../src/discovery/types'

/** Deterministic test secret: never a real installation secret. */
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

const tempRoots: string[] = []

async function makeCacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-cache-stores-'))
  tempRoots.push(root)
  return path.join(root, 'data', '@jc3212', 'opencode-models-discovery')
}

afterAll(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  )
})

function baseIdentity(fingerprint = 'aa'.repeat(32)): SemanticInventoryIdentityV3 {
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

function route(overrides: Partial<DiscoveredRoute> = {}): DiscoveredRoute & Record<string, unknown> {
  return {
    selectionKey: 'm1',
    invocationId: 'm1',
    routeKind: 'model-name',
    readiness: 'ready',
    maturity: 'stable',
    ...overrides,
  }
}

describe('inventory store', () => {
  it('round-trips a complete record under its identity hash with tight permissions', async () => {
    const cacheRoot = await makeCacheRoot()
    const routes = [route(), route({ selectionKey: 'm2', invocationId: 'm2' })]
    const saved = await saveCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity(),
      activatedFromCredentialGenerationHash: 'c'.repeat(64),
      routes,
    })

    expect(saved.identityHash).toMatch(/^[0-9a-f]{64}$/)
    const dir = path.join(cacheRoot, 'inventories', 'v3')
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600)

    const loaded = await loadCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity(),
    })
    expect(loaded).toBeDefined()
    expect(loaded?.completeness).toBe('complete')
    expect(loaded?.routes).toEqual(routes)
    expect(loaded?.activatedFromCredentialGenerationHash).toBe('c'.repeat(64))

    // No temp leftovers beside the published file.
    const entries = await readdir(dir)
    expect(entries).toEqual([`${saved.identityHash}.json`])
  })

  it('isolates different identities into different files and lookups', async () => {
    const cacheRoot = await makeCacheRoot()
    await saveCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity('11'.repeat(32)),
      activatedFromCredentialGenerationHash: 'c'.repeat(64),
      routes: [route({ selectionKey: 'keyA' })],
    })
    const savedB = await saveCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity('22'.repeat(32)),
      activatedFromCredentialGenerationHash: 'd'.repeat(64),
      routes: [route({ selectionKey: 'keyB' })],
    })

    const loadedA = await loadCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity('11'.repeat(32)),
    })
    expect(loadedA?.routes.map((r) => r.selectionKey)).toEqual(['keyA'])
    // Identity B must not observe A's routes and vice versa.
    const loadedB = await loadCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity('22'.repeat(32)),
    })
    expect(loadedB?.routes.map((r) => r.selectionKey)).toEqual(['keyB'])
    expect(savedB.identityHash).not.toBe(loadedA?.identityHash)
  })

  it('treats corrupt or tampered files as absent instead of throwing', async () => {
    const cacheRoot = await makeCacheRoot()
    const saved = await saveCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity(),
      activatedFromCredentialGenerationHash: 'c'.repeat(64),
      routes: [route()],
    })

    await writeFile(saved.path, '{not json', 'utf8')
    await expect(
      loadCompleteInventory({ cacheRoot, secret: SECRET, identity: baseIdentity() }),
    ).resolves.toBeUndefined()

    // Restore a valid record, then tamper: stored generation no longer
    // matches what the identity hash covers, and the record must still be
    // treated as absent rather than trusted.
    await saveCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity(),
      activatedFromCredentialGenerationHash: 'c'.repeat(64),
      routes: [route()],
    })
    const raw = JSON.parse(await readFile(saved.path, 'utf8')) as {
      identity?: { runtimeAuth?: { identityFingerprint?: string } }
    }
    raw.identity?.runtimeAuth &&
      (raw.identity.runtimeAuth.identityFingerprint = 'ff'.repeat(32))
    await writeFile(saved.path, JSON.stringify(raw), 'utf8')
    await expect(
      loadCompleteInventory({ cacheRoot, secret: SECRET, identity: baseIdentity() }),
    ).resolves.toBeUndefined()
  })

  it('deletes the exact identity only once', async () => {
    const cacheRoot = await makeCacheRoot()
    await saveCompleteInventory({
      cacheRoot,
      secret: SECRET,
      identity: baseIdentity(),
      activatedFromCredentialGenerationHash: 'c'.repeat(64),
      routes: [],
    })
    await expect(
      deleteCompleteInventory({ cacheRoot, secret: SECRET, identity: baseIdentity() }),
    ).resolves.toBe(true)
    await expect(
      deleteCompleteInventory({ cacheRoot, secret: SECRET, identity: baseIdentity() }),
    ).resolves.toBe(false)
    await expect(
      loadCompleteInventory({ cacheRoot, secret: SECRET, identity: baseIdentity() }),
    ).resolves.toBeUndefined()
  })
})

describe('route sanitization', () => {
  it('drops unknown fields before persisting (allowlist)', async () => {
    const dirty = route({ evilExtra: 'smuggled' }) as DiscoveredRoute
    const clean = sanitizeRoutes([dirty])
    expect(clean).toHaveLength(1)
    expect(Object.keys(clean[0]).sort()).toEqual([
      'invocationId',
      'maturity',
      'readiness',
      'routeKind',
      'selectionKey',
    ])
  })

  it('rejects malformed routes instead of writing them as complete', async () => {
    expect(() =>
      sanitizeRoutes([{ ...route(), selectionKey: '' } as DiscoveredRoute]),
    ).toThrow(TypeError)
    expect(() =>
      sanitizeRoutes([{ ...route(), routeKind: 'teleport' } as unknown as DiscoveredRoute]),
    ).toThrow(TypeError)
    expect(() => sanitizeRoutes([null as unknown as DiscoveredRoute])).toThrow(TypeError)
  })
})

describe('auth tombstones', () => {
  it('blocks exactly the failed identity+generation pair', async () => {
    const cacheRoot = await makeCacheRoot()
    const identityHash = 'a'.repeat(64)
    const genOld = 'c'.repeat(64)
    const genNew = 'd'.repeat(64)

    await writeAuthTombstone({
      cacheRoot,
      secret: SECRET,
      identityHash,
      credentialGenerationHash: genOld,
      reason: 'confirmed-auth-failure',
    })

    const blocked = await hasAuthTombstone(cacheRoot, SECRET, identityHash, genOld)
    expect(blocked?.reason).toBe('confirmed-auth-failure')

    // New generation does not inherit the old tombstone.
    await expect(hasAuthTombstone(cacheRoot, SECRET, identityHash, genNew)).resolves.toBeUndefined()

    await expect(clearAuthTombstone(cacheRoot, SECRET, identityHash, genOld)).resolves.toBe(true)
    await expect(hasAuthTombstone(cacheRoot, SECRET, identityHash, genOld)).resolves.toBeUndefined()
    await expect(clearAuthTombstone(cacheRoot, SECRET, identityHash, genOld)).resolves.toBe(false)
  })

  it('rejects malformed reasons and hash-shaped inputs', async () => {
    const cacheRoot = await makeCacheRoot()
    await expect(
      writeAuthTombstone({
        cacheRoot,
        secret: SECRET,
        identityHash: 'not-a-hash',
        credentialGenerationHash: 'c'.repeat(64),
        reason: 'boom',
      }),
    ).rejects.toThrow(TypeError)
    await expect(
      writeAuthTombstone({
        cacheRoot,
        secret: SECRET,
        identityHash: 'a'.repeat(64),
        credentialGenerationHash: 'c'.repeat(64),
        reason: 'Not A Reason!',
      }),
    ).rejects.toThrow(TypeError)
  })
})

describe('quarantine store', () => {
  it('appends bounded diagnostic entries with restricted names', async () => {
    const cacheRoot = await makeCacheRoot()
    const appended = await appendQuarantineEntry({
      cacheRoot,
      secret: SECRET,
      kind: 'partial-response',
      reason: 'pagination-loop',
      identityHash: 'a'.repeat(64),
      summary: { pages: 50, distinct: 3 },
    })

    const stem = path.basename(appended.path, '.json')
    expect(() => assertTimestampedHashName(stem)).not.toThrow()

    const dir = path.join(cacheRoot, 'quarantine', 'v1')
    const raw = JSON.parse(await readFile(appended.path, 'utf8')) as Record<string, unknown>
    expect(raw.kind).toBe('partial-response')
    expect(raw.summary).toEqual({ pages: 50, distinct: 3 })

    // Same dir also accepts other kinds; names stay unique per content.
    await appendQuarantineEntry({
      cacheRoot,
      secret: SECRET,
      kind: 'schema-invalid',
      reason: 'missing-field',
    })
    const entries = await readdir(dir)
    expect(entries).toHaveLength(2)
  }, 15000)

  it('rejects unsafe summary keys and non-scalar values', async () => {
    const cacheRoot = await makeCacheRoot()
    await expect(
      appendQuarantineEntry({
        cacheRoot,
        secret: SECRET,
        kind: 'other',
        reason: 'bad-key',
        summary: { '../../evil': true },
      }),
    ).rejects.toThrow(TypeError)
    await expect(
      appendQuarantineEntry({
        cacheRoot,
        secret: SECRET,
        kind: 'other',
        reason: 'nested-value',
        summary: { deep: { nested: 1 } as unknown as string },
      }),
    ).rejects.toThrow(TypeError)
  })

  it('prunes oldest entries beyond the cap deterministically', async () => {
    const cacheRoot = await makeCacheRoot()
    for (let i = 0; i < 5; i += 1) {
      const at = new Date(Date.UTC(2026, 7, 23, 10, 0, i)).toISOString()
      await appendQuarantineEntry({
        cacheRoot,
        secret: SECRET,
        kind: 'other',
        reason: `tick-${i}`,
        observedAt: at,
        cap: 3,
      })
    }
    const dir = path.join(cacheRoot, 'quarantine', 'v1')
    const remaining = (await readdir(dir)).sort().reverse()
    expect(remaining).toHaveLength(3)
    // Newest three survive: seconds 04, 03, 02.
    expect(remaining[0]).toContain('100004-')
    expect(remaining[2]).toContain('100002-')
  })
})

describe('safe-file guards', () => {
  it('enforces restricted file names', () => {
    expect(() => assertFullHashName('A'.repeat(64))).toThrow(CacheFileError)
    expect(() => assertFullHashName('a'.repeat(63))).toThrow(CacheFileError)
    expect(() => assertFullHashName('../escape')).toThrow(CacheFileError)
    expect(() => assertTimestampedHashName('../../escape')).toThrow(CacheFileError)
    expect(() => assertTimestampedHashName('20260823-abcdefgh')).toThrow(CacheFileError)
  })

  it('refuses writes that would escape the cache root', async () => {
    const cacheRoot = await makeCacheRoot()
    await expect(
      writeJsonAtomic(cacheRoot, '../../../etc', `${'a'.repeat(64)}.json`, {}),
    ).rejects.toMatchObject({ code: 'CONTAINMENT_VIOLATION' })
  })
})
