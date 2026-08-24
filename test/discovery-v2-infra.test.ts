import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveInferenceCredentialV2 } from '../src/discovery/credentials/v2'
import { loadProjection, saveProjection } from '../src/cache/projection-store'
import { migrateLegacyProviderState } from '../src/cache/migrate-v2'

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const tempRoots: string[] = []

async function cacheRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'omd-v2-infra-'))
  tempRoots.push(root)
  return path.join(root, 'cache')
}

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

describe('resolveInferenceCredentialV2', () => {
  it('passes setup-local phase through without choosing a private host API', async () => {
    const phases: string[] = []
    const result = await resolveInferenceCredentialV2(
      { providerId: 'relay', phase: 'setup-local' },
      {
        resolveConnection: async (providerId, phase) => {
          phases.push(`${providerId}:${phase}`)
          return {
            providerId,
            credentialKind: 'api',
            credentialType: 'bearer',
            material: 'sk-runtime',
            stablePrincipal: 'principal-1',
            materialVersion: 'generation-1',
            source: 'local-connection-cache',
          }
        },
      },
    )
    expect(phases).toEqual(['relay:setup-local'])
    expect(result).toMatchObject({ kind: 'resolved', identityKind: 'stable-principal', materialVersion: 'generation-1' })
  })

  it('allows background resolution to be owned by the caller scope', async () => {
    const result = await resolveInferenceCredentialV2(
      { providerId: 'relay', phase: 'background' },
      {
        resolveConnection: async () => ({ providerId: 'relay', credentialKind: 'oauth', material: 'token', credentialType: 'oauth2' }),
      },
    )
    expect(result).toMatchObject({ kind: 'resolved', credentialKind: 'oauth', identityKind: 'material' })
  })

  it('fails closed for unavailable, disabled, invalid and material-less descriptors', async () => {
    await expect(resolveInferenceCredentialV2({ providerId: 'p', phase: 'setup-local' }, { resolveConnection: async () => undefined })).resolves.toEqual({ kind: 'unresolved', providerId: 'p', reason: 'connection-unavailable' })
    await expect(resolveInferenceCredentialV2({ providerId: 'p', phase: 'setup-local' }, { resolveConnection: async () => ({ providerId: 'p', credentialKind: 'none' }) })).resolves.toMatchObject({ reason: 'credential-disabled' })
    await expect(resolveInferenceCredentialV2({ providerId: 'p', phase: 'setup-local' }, { resolveConnection: async () => ({ providerId: 'other', credentialKind: 'api', material: 'x' }) })).resolves.toMatchObject({ reason: 'invalid-descriptor' })
    await expect(resolveInferenceCredentialV2({ providerId: 'p', phase: 'setup-local' }, { resolveConnection: async () => ({ providerId: 'p', credentialKind: 'api' }) })).resolves.toMatchObject({ reason: 'material-unavailable' })
  })

  it('converts resolver failures into connection-unavailable', async () => {
    const result = await resolveInferenceCredentialV2(
      { providerId: 'p', phase: 'background' },
      { resolveConnection: async () => { throw new Error('private host failure') } },
    )
    expect(result).toEqual({ kind: 'unresolved', providerId: 'p', reason: 'connection-unavailable' })
  })
})

describe('projection-store', () => {
  const key = { cacheRoot: '', secret: SECRET, consumerKeyHash: HASH_A, pipelineHash: HASH_B }

  it('round-trips a normalized projection and isolates identity/plan generations', async () => {
    const root = await cacheRoot()
    const saved = await saveProjection({
      ...key,
      cacheRoot: root,
      identityHash: HASH_A,
      planGeneration: 4,
      projectionState: 'fresh',
      selectionKeys: ['z', 'a', 'a'],
      pluginOwnedSelectionKeys: ['z'],
      sourceRevision: 'rev-1',
      createdAt: '2026-08-23T00:00:00.000Z',
    })
    expect(saved.endsWith('.json')).toBe(true)
    const loaded = await loadProjection({ ...key, cacheRoot: root, expectedIdentityHash: HASH_A, minimumPlanGeneration: 4 })
    expect(loaded).toMatchObject({ projectionState: 'fresh', planGeneration: 4, selectionKeys: ['a', 'z'], pluginOwnedSelectionKeys: ['z'] })
    await expect(loadProjection({ ...key, cacheRoot: root, expectedIdentityHash: HASH_B })).resolves.toBeUndefined()
    await expect(loadProjection({ ...key, cacheRoot: root, minimumPlanGeneration: 5 })).resolves.toBeUndefined()
    const raw = JSON.parse(await readFile(saved, 'utf8')) as Record<string, unknown>
    expect(raw.consumerKeyHash).toBe(HASH_A)
  })

  it('rejects malformed hashes and invalid plan generations', async () => {
    const root = await cacheRoot()
    await expect(saveProjection({ ...key, cacheRoot: root, consumerKeyHash: 'bad', identityHash: HASH_A, planGeneration: 0, projectionState: 'fresh', selectionKeys: [], pluginOwnedSelectionKeys: [] })).rejects.toThrow(TypeError)
    await expect(saveProjection({ ...key, cacheRoot: root, identityHash: HASH_A, planGeneration: -1, projectionState: 'fresh', selectionKeys: [], pluginOwnedSelectionKeys: [] })).rejects.toThrow(TypeError)
  })
})

describe('migrateLegacyProviderState', () => {
  it('migrates only safe overrides and counts but never imports discovered models', () => {
    const result = migrateLegacyProviderState('relay', {
      version: 2,
      models: { old: { id: 'old' }, another: { id: 'another' } },
      overrides: {
        old: { reasoning: { enabled: true }, id: 'must-not-move', secret: 'drop' },
        empty: {},
        unsafe: { token: 'drop', nested: { effort: 'high' } },
      },
    })
    expect(result.status).toBe('migrated-overrides')
    expect(result.discoveredModelsNotMigrated).toBe(2)
    expect(result.migrated).toEqual([
      { schemaVersion: 1, providerId: 'relay', modelId: 'old', override: { reasoning: { enabled: true } }, migratedFrom: 'provider-model-store-v2' },
      { schemaVersion: 1, providerId: 'relay', modelId: 'unsafe', override: { nested: { effort: 'high' } }, migratedFrom: 'provider-model-store-v2' },
    ])
    expect(result.skippedModelIds).toEqual(['empty'])
  })

  it('skips malformed legacy states and never deletes source data', () => {
    expect(migrateLegacyProviderState('relay', { version: 1, models: { old: {} } })).toMatchObject({ status: 'skipped-invalid', discoveredModelsNotMigrated: 1 })
    expect(migrateLegacyProviderState('', { version: 2, overrides: {} })).toMatchObject({ status: 'skipped-invalid' })
    expect(migrateLegacyProviderState('relay', { version: 2, overrides: {} })).toMatchObject({ status: 'no-overrides' })
  })
})
