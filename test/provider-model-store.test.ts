import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ProviderModelStore, getProviderStateFileName, isInventoryFresh, mergeModelOverride } from '../src/plugin/provider-model-store.ts'

const identity = {
  id: 'local/vllm',
  baseURL: 'http://127.0.0.1:8000',
  endpoint: '/v1/models',
}

describe('ProviderModelStore', () => {
  it('uses one safe provider file component', () => {
    const fileName = getProviderStateFileName('../local/vllm')

    expect(fileName).toBe('provider-..%2Flocal%2Fvllm.json')
    expect(fileName).not.toContain(path.sep)
  })

  it('writes credential-free enhanced model configurations and reads them only for the matching identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'models-discovery-store-'))
    try {
      const store = new ProviderModelStore(root)
      await expect(store.read(identity)).resolves.toBeUndefined()
      await expect(store.saveModels(identity, {
        qwen: {
          id: 'qwen',
          name: 'Qwen',
        authorization: 'Bearer secret',
        apiKey: 'secret',
          limit: { context: 32768 },
        },
      })).resolves.toBe(true)

      const contents = await readFile(store.getStatePath(identity.id)!, 'utf8')
      expect(contents).not.toContain('secret')

      const state = await store.read(identity)
      expect(state).toMatchObject({
        version: 2,
        provider: identity,
        models: { qwen: { id: 'qwen', name: 'Qwen', limit: { context: 32768 } }, },
      })
      await expect(store.read({ ...identity, endpoint: '/models' })).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves overrides during a successful inventory replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'models-discovery-store-'))
    try {
      const store = new ProviderModelStore(root)
      const previous = {
        version: 2 as const,
        provider: identity,
        fetchedAt: new Date().toISOString(),
        models: { old: { id: 'old', name: 'Old' } },
        overrides: { qwen: { reasoning: true } },
      }

      await store.saveModels(identity, { qwen: { id: 'qwen', name: 'Qwen' } }, previous)
      await expect(store.read(identity)).resolves.toMatchObject({
        models: { qwen: { id: 'qwen' } },
        overrides: { qwen: { reasoning: true } },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('handles TTL boundaries and merges overrides without allowing id changes', () => {
    const now = Date.now()
    const state = {
      version: 2 as const,
      provider: identity,
      fetchedAt: new Date(now - 1000).toISOString(),
      models: { qwen: { id: 'qwen', name: 'Qwen' } },
    }

    expect(isInventoryFresh(state, 2, now)).toBe(true)
    expect(isInventoryFresh(state, 0, now)).toBe(false)
    expect(mergeModelOverride(
      { id: 'qwen', limit: { context: 8192 }, modalities: { input: ['text'] } },
      { id: 'changed', limit: { output: 1024 }, modalities: { input: ['image'] } }
    )).toEqual({
      id: 'qwen',
      limit: { context: 8192, output: 1024 },
      modalities: { input: ['image'] },
    })
  })
})
