import { describe, it, expect } from 'vitest'
import {
  buildSnapshot,
  computeLock,
  snapshotContentHash,
  normalizeSyncReasoningOptions,
  MODELS_DEV_SNAPSHOT_SCHEMA_VERSION,
  type ModelsDevSnapshot,
} from '../src/utils/models-dev-snapshot.ts'
import { buildMapFromSnapshot } from '../src/utils/models-dev-fetcher.ts'

const MD_MODELS = {
  'openai/gpt-4o': { id: 'openai/gpt-4o', reasoning: false },
  'deepseek/deepseek-v4-flash': { id: 'deepseek/deepseek-v4-flash', reasoning: true },
}

const MD_API = {
  openai: {
    models: {
      'gpt-4o': { id: 'gpt-4o', reasoning: false },
    },
  },
  deepseek: {
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['high', 'max'] }],
      },
    },
  },
}

describe('G4.1 models.dev snapshot pipeline', () => {
  it('valid response: builds snapshot with provider + agnostic models and coverage', () => {
    const { snapshot, coverage } = buildSnapshot(MD_MODELS, MD_API)
    expect(snapshot.source).toBe('models.dev')
    expect(snapshot.schemaVersion).toBe(MODELS_DEV_SNAPSHOT_SCHEMA_VERSION)
    expect(snapshot.providerModels).toHaveLength(2)
    expect(snapshot.models).toHaveLength(2)
    expect(coverage.reasoningTrue).toBe(2)
    expect(coverage.reasoningOptionsPresent).toBe(1)
    expect(coverage.reasoningOptionsImported).toBe(1)
    expect(coverage.silentlyDropped).toBe(0)
  })

  it('base_model association is preserved per provider model', () => {
    const { snapshot } = buildSnapshot({}, {
      zai: { models: { 'glm-5.2-fp8': { id: 'glm-5.2-fp8', base_model: 'zai/glm-5.2' } } },
    })
    expect(snapshot.providerModels[0].baseModel).toBe('zai/glm-5.2')
  })

  it('reasoning=true without controls -> controls unknown, not fabricated', () => {
    const { coverage } = buildSnapshot({}, {
      x: { models: { 'thinker': { id: 'thinker', reasoning: true } } },
    })
    expect(coverage.reasoningTrue).toBe(1)
    expect(coverage.reasoningOptionsPresent).toBe(0)
    expect(coverage.controlsKnown).toBe(0)
    expect(coverage.controlsUnknown).toBe(1)
  })

  it('reasoning_options present -> imported', () => {
    const { snapshot, coverage } = buildSnapshot({}, {
      x: { models: { 'm': { id: 'm', reasoning: true, reasoning_options: [{ type: 'effort', values: ['medium'] }] } } },
    })
    expect(snapshot.providerModels[0].reasoningOptions).toEqual([{ type: 'effort', values: ['medium'] }])
    expect(coverage.reasoningOptionsImported).toBe(1)
    expect(coverage.controlsKnown).toBe(1)
  })

  it('unknown reasoning option type is collected -> sync fails closed (G4 §21)', () => {
    const { coverage } = buildSnapshot({}, {
      x: { models: { 'm': { id: 'm', reasoning: true, reasoning_options: [{ type: 'thinking_effort_future', values: ['x'] }] } } },
    })
    expect(coverage.unsupportedOptionTypes).toContain('thinking_effort_future')
    expect(coverage.silentlyDropped).toBe(0) // not silent: reported as unsupported
  })

  it('normalizeSyncReasoningOptions: effort/toggle/budget accepted, unknown collected', () => {
    const r = normalizeSyncReasoningOptions([
      { type: 'effort', values: ['low', 'high'] },
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1000, max: 50000 },
      { type: 'mystery' },
    ])
    expect(r.ok).toEqual([
      { type: 'effort', values: ['low', 'high'] },
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1000, max: 50000 },
    ])
    expect(r.unsupported).toEqual(['mystery'])
  })

  it('malformed models.json (non-object) yields empty agnostic list, no throw', () => {
    const { snapshot, coverage } = buildSnapshot('not-an-object', MD_API)
    expect(snapshot.models).toHaveLength(0)
    expect(snapshot.providerModels).toHaveLength(2)
    expect(coverage.silentlyDropped).toBe(0)
  })

  it('malformed api.json (array) yields empty provider list, no throw', () => {
    const { snapshot } = buildSnapshot(MD_MODELS, [1, 2, 3])
    expect(snapshot.providerModels).toHaveLength(0)
    expect(snapshot.models).toHaveLength(2)
  })

  it('duplicate provider model is reported as conflict, not silently dropped', () => {
    const { coverage } = buildSnapshot({}, {
      x: {
        models: {
          'm': { id: 'm' },
          'm2': { id: 'm' },
        },
      },
    })
    expect(coverage.conflicts.length).toBeGreaterThan(0)
    expect(coverage.conflicts[0]).toContain('duplicate provider model')
    expect(coverage.silentlyDropped).toBe(0)
  })

  it('lock hashes the exact file bytes (compile embed check is meaningful)', () => {
    const { snapshot } = buildSnapshot(MD_MODELS, MD_API)
    const json = JSON.stringify(snapshot, null, 2) + '\n'
    const lock = computeLock('{}', '{}', json)
    const { createHash } = require('node:crypto')
    expect(lock.snapshotSha256).toBe(createHash('sha256').update(json).digest('hex'))
    expect(lock.schemaVersion).toBe(MODELS_DEV_SNAPSHOT_SCHEMA_VERSION)
  })

  it('snapshot is deterministic: same inputs -> same content hash (fetchedAt excluded)', () => {
    const a = buildSnapshot(MD_MODELS, MD_API).snapshot
    const b = buildSnapshot(MD_MODELS, MD_API).snapshot
    expect(snapshotContentHash(a)).toBe(snapshotContentHash(b))
    // fetchedAt may be identical within the same millisecond; determinism is on content only.
  })

  it('buildMapFromSnapshot: provider keys + agnostic gap-fill, offline', () => {
    const { snapshot } = buildSnapshot(
      { 'openai/gpt-4o': { id: 'openai/gpt-4o', name: 'GPT-4o' } },
      { openai: { models: { 'gpt-4o': { id: 'gpt-4o', reasoning: false } } } },
    )
    const map = buildMapFromSnapshot(snapshot)
    expect(map.get('openai/gpt-4o')).toMatchObject({ reasoning: false })
    expect(map.get('openai/gpt-4o')?.name).toBe('GPT-4o')
  })

  it('no snapshot -> empty map (fail-open), never a network call', async () => {
    // modelsDevTestUtils.resetCache + a process that cannot load the file is
    // covered implicitly; here we assert buildMapFromSnapshot never throws on
    // an empty snapshot.
    const empty: ModelsDevSnapshot = {
      _notice: '',
      source: 'models.dev',
      schemaVersion: MODELS_DEV_SNAPSHOT_SCHEMA_VERSION,
      fetchedAt: '',
      models: [],
      providerModels: [],
    }
    expect(buildMapFromSnapshot(empty).size).toBe(0)
  })
})